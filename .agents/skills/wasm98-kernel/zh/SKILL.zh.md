<!-- 中文审阅版，对应 ../SKILL.md。agent 实际加载的是英文版；修改时两边同步。 -->
---
name: wasm98-kernel
description: 在扩展 wasm98 的 WebAssembly 内核（kernel/kernel.c、kernel/nt.c、kernel/nt.h）、Hyper-V 风格的 hypervisor（hypervisor/hv.c）、guest 镜像（guest/guest.c）或它们的 JS 胶水层（web/js/kernel.js、web/js/hv.js）时使用。例如：加入现代 NT 内核机制（对象命名空间、ALPC、IOCP、pushlock、PnP、MM 页链表、完整性级别、PPL、ETW、Job 对象），Hyper-V 特性（TLFS 超级调用、SynIC、VMBus、分区权限），VBS/VSM（VTL0/VTL1、安全内核、HVCI、Credential Guard、KDP），或 Intel VT-x 模型（VMXON、VMCS、VM exit、EPT、VPID、嵌套虚拟化）。修改 HV_ABI.md 或 kernel/hv 测试套件时也使用。
---

# wasm98 内核 / Hyper-V / VBS 开发

本仓库是浏览器里的 Windows 98 桌面。操作系统状态放在两个用 C 编译出来的 freestanding wasm32 镜像里：

| 镜像 | 源码 | 负责 | 测试 |
|---|---|---|---|
| `web/wasm/kernel.wasm` | `kernel/kernel.c`（Win9x 层）、`kernel/nt.c` + `nt.h`（NT executive） | 进程、线程、对象、句柄、令牌、IRQL/DPC/APC、IRP、内存管理、hive、bugcheck | `node tools/kernel_test.mjs` |
| `web/wasm/hypervisor.wasm` | `hypervisor/hv.c` + `guest/guest.c`（共用同一块线性内存） | 分区、VP、SLAT、超级调用、MSR/CPUID、SynIC、synthetic timer、VMBus | `node tools/hv_test.mjs` |

契约文档是 `HV_ABI.md`（内核与 HV 的 ABI）和 `CONTRACT.md`（应用 API）。改动之前把两份都读完，然后读 `references/pitfalls.md`。它很短，几乎涵盖了这类工作所有出错的方式。

## "wasm 里的 Windows 内核"在这里是什么意思（读一遍，记住）

wasm32 没有 MMU、没有 CPU 特权级、没有中断、没有可捕获的陷阱，主线程上没有多线程，也无法执行 x86 代码。所以本项目里的每个机制都是真实机制的**语义忠实的状态机模型**：对象、状态转换、状态码、不变量、失败方式都和真实系统一致，但都不是硬件。这种做法是正当的，但有两个推论：

1. **忠实度体现在语义上。** 一个机制算完成，是指它的可观察行为和 Windows 一致：Windows 拒绝的它也拒绝，返回对应的 NTSTATUS / HV_STATUS，顺序规则相同，相同的失败计数器会增加。只有名字对、没有任何强制检查的结构体不算完成。
2. **安全特性需要模型里有真实的隔离边界。** 如果"攻击方"能用一个普通 C 指针直接写被保护的字节，HVCI、VTL1、Credential Guard 就都没有意义。开始任何 VBS 工作前先读 `references/vbs-vtx.md` §1。

不要生成 x86 汇编或内联汇编，也不要声称能运行真实的 Windows 二进制或驱动。

## 工作流程（每次改动）

1. **一次只定一个机制。** 从 `references/roadmap.md` 里选，除非用户另有指示，否则按层级顺序来。先把它在真实 Windows 里的行为写下来：状态、状态码、不变量、会拒绝什么。使用真实名称（`KeWaitForMultipleObjects`、`HvCallModifyVtlProtectionMask`、exit reason 48 `EPT_VIOLATION` ……）。
2. **先设计 ABI。** 写 C 之前，先在 `HV_ABI.md` 里加好对应章节：导出函数、字段编号、状态码、计数器。每个新导出都是永久 ABI（见"ABI 规则"）。
3. **用 C 实现**，放进正确的编译单元，使用静态 arena、有界循环、返回状态码（见"C 规则"）。
4. **测试。** 在 `tools/kernel_test.mjs` / `tools/hv_test.mjs` 里加断言，覆盖正常路径和**每一条拒绝路径**。没有负向测试的机制不算完成。
5. **胶水和 UI（可选）。** 在 `web/js/kernel.js` / `web/js/hv.js` 里暴露。任务管理器和 Hyper-V 管理器可以显示计数器。应用仍然只使用文档化的 `W98` API。
6. **跑门禁**（见下文），报告两套测试的检查数。

每次改动只做一个机制，测试和代码放在同一次改动里。不要一次塞进五个做了一半的机制。

## 门禁（报告完成前必须通过）

```sh
git status --short web/wasm/                 # 构建前记下状态
./tools/build_kernel.sh && ./tools/build_hv.sh
git status --short web/wasm/                 # 两个 .wasm 都应显示为已修改（M），绝不能是已删除（D）
node tools/kernel_test.mjs                   # 必须以 "ALL GREEN — N checks passed" 结尾
node tools/hv_test.mjs                       # 同上；N 不能减少
for f in web/js/*.js web/js/apps/*.js; do node --check "$f"; done
```

- **构建失败时，链接器会删掉已提交的 `.wasm`。** 立刻执行 `git checkout -- web/wasm/<file>.wasm`，否则测试会对着一个不存在的二进制跑，恢复后又会对着旧二进制跑。构建步骤失败时，即使测试是绿的也不能报告成功，因为那测的是旧二进制。
- 工具链：需要带 wasm32 target 的 `clang` 和 `wasm-ld`。Homebrew 的 `llvm` 不带 `wasm-ld`。解决办法是 `brew install lld`（它提供 `wasm-ld`），或者把带 lld 的 LLVM 放在 PATH 前面。如果构建不了，停下来告诉用户。不要手改 wasm，也不要拿旧二进制来"验证"。
- 浏览器冒烟测试（改了胶水或 UI 时）：`python3 tools/serve.py -p 8098`，然后打开页面。桌面必须以 `wasm` 模式启动，VM 控制台必须显示 guest 心跳，`hypervisor.wasm` 缺失时桌面也必须能启动。
- 用户可能在 `web/js/*.js` 里有未提交的工作。编辑 JS 前先看 `git status` 和 `git diff`，绝不要回滚或覆盖不是你做的改动。

## ABI 规则

- 构建开了 `--export-all`，所以**所有非 `static` 函数都会被导出**，成为 ABI。内部辅助函数要标 `static`。新增非 static 符号前，在该镜像的两个编译单元里 grep 一下名字（kernel.c 和 nt.c 链接在一起，hv.c 和 guest.c 也是）。
- 导出函数只接收和返回 `u32`/`i32`。`u64` 参数或返回值在 JS 里会变成 `BigInt`，胶水层会悄无声息地坏掉。64 位值拆成 lo/hi，像现有的 `msr_read(…, *lo, *hi)` 那样。
- 字段访问器沿用现有模式 `x_field(id, f)`，字段编号写进 HV_ABI.md。可以追加新编号，但绝不能重新编号或复用。
- 保持旧 API 可用：`k_proc_*`、扁平的 `k_reg_*`、`W98` 应用 API、`W98HV` 接口。现有的超级调用号和 MSR 编号保持不变。新增的尽量使用**真实的 TLFS 编号**。凡是偏离真实 Windows 的地方，用 `DEVIATION:` 注释标出，并写进 HV_ABI.md。
- 每次调用可能导致内存增长的函数后，JS 必须重新创建 typed array 视图（`kernel.wasm` 最多能涨到 256 MB）。沿用现有的 `bytes()` 模式，绝不要缓存基于 `memory.buffer` 的 `Uint8Array`。

## C 规则

- Freestanding：没有 libc，`-fno-builtin`。clang 在结构体拷贝和大的初始化器上仍会生成 `memcpy`/`memset` 调用，所以每个镜像必须恰好定义一次。在 kernel.wasm 里，`kernel/kernel.c` 导出了它们，nt.c 依赖这一点，所以不要在 nt.c 里重复定义（会符号冲突）。hypervisor.wasm 在 hv.c 里有 `static` 版本；guest.c 如果以后需要，得有自己的 static 版本。缺少符号会表现为链接错误或者一个 import，而镜像必须**零 import**，因为它是用 `{}` 实例化的。
- 现有 arena 之外不做动态分配。每张表都有 `NT_MAX_*` / `MAX_*` 上限。表满时返回状态码（`STATUS_INSUFFICIENT_RESOURCES`、`HV_STATUS_INSUFFICIENT_MEMORY`）并增加计数器，绝不越界。
- **任何操作都不能阻塞，也不能无界循环。** 所有代码都跑在浏览器主线程上，由心跳驱动的 `k_tick` / `hv_schedule` 推进。"等待"是一个状态加上之后的唤醒。耗时工作做成分阶段的状态机，像 guest.c 里的 `gstep()` 那样。每个循环都要有预算。
- 内存预算是固定的。hypervisor.wasm 的 `initial = max = 32 MB`，其中 16 MB 是 `PHYS`，所以加大 `PHYS`、`MAX_PARTS` 或每个 VP 的结构体（每个 `Vp` 内嵌 16 条 256 字节的消息）都可能撑爆镜像。kernel.wasm 的静态数据上限由 `nt.h` 决定。提高上限后，检查构建出的大小，并确认两套测试里实例化依然成功。
- 确定性：时间通过参数传入（`k_tick(nowMs)`、`hv_schedule(elapsed)`），绝不用其他方式读时间。测试里传入明确的时间。
- 持久化：hive 和文件系统以 `KFS1`/`KREG1` 文本格式存进 IndexedDB。改格式需要升级版本号，并且解析器仍要能加载旧版本，否则所有现有用户刷新后桌面状态都会丢失。

## Hyper-V / VBS / VT-x 专项

做这类工作前先读 `references/vbs-vtx.md`。不可妥协的几点：

- **先做分区权限。** 目前任何子分区调用 `HvCallCreatePartition`、`HvCallDepositMemory`、`HvCallMapGpaPages`、`HvCallCreateVp` 都会成功。CPUID `0x40000003` 声明了一个权限掩码，但没有任何地方检查它。真实的 Hyper-V 用 `HV_PARTITION_PRIVILEGE_MASK` 的各位（`CreatePartitions`、`AccessMemoryPool` 等）来控制这些调用，不满足时返回 `HV_STATUS_ACCESS_DENIED`。在其上搭 VSM 之前，先把这个修好，并配上负向测试。
- **SLAT 表项格式放不下权限位。** `slat[] = (pfn << 2) | (flags & 3)` 只有 present 和 writable。HVCI、KDP、EPT、VTL 保护都需要 R/W/X（以及每个 VTL 各自的掩码）。只在一个地方改编码，同步更新 `slat_pfn`/`slat_set`/`gpa_state_of` 和每一处 `& 3u`，并保持 `hv_gpa_state` 返回文档里约定的值。
- **超级调用目前是同步的 C 调用。** guest 直接调用 `hv_vmcall()`。VT-x 模型（VM exit、VMCS、exit reason）要求把它改成"guest 带着 exit reason 停下，hypervisor 处理，VM 恢复执行"。这是路线图里最大的一次重构，要有意识地一次做完，作为单独的一次改动。

## 需要上报用户（不要自行决定）

- 引入 guest 指令集解释器（要做到真实的 EPT 执行权限 / HVCI 语义就需要它，见 vbs-vtx.md §3），或者把分区、VTL1 拆成独立的 wasm 实例。这些是架构变更。
- 任何会破坏文档化 ABI 字段、超级调用号或快照格式的改动。
- 提高 hypervisor 固定的 32 MB 内存，或者内核 256 MB 的上限。
- 任何在运行时增加网络请求的改动。这是不允许的，所以答案是不行。

## 参考文档

- `references/pitfalls.md`：这项工作中的难点和容易出错的地方，附具体症状。
- `references/roadmap.md`：按优先级排列的现代 NT、Hyper-V、VBS、VT-x 机制清单，每项附验收测试。
- `references/vbs-vtx.md`：隔离边界、VSM/VTL、HVCI、VT-x/VMCS/EPT 模型以及嵌套虚拟化的设计说明。
