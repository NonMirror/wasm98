<!-- 中文审阅版，对应 ../references/vbs-vtx.md -->
# VBS、VSM 与 VT-x：设计说明

## 1. 隔离边界问题（最先解决）

在真实硬件上，VBS 之所以有效，是因为 VTL0 *物理上无法*寻址 VTL1 的内存：SLAT 会拒绝。在本仓库里，guest 是和 hypervisor 链接在同一个 wasm 实例里的 C 代码。隔离只是一种约定：guest.c 只通过 `hv_g_load` / `hv_g_store` 访问内存，而这两个函数会走 SLAT。canary 页能事后发现一部分违规。

这种约定只有在**有机制检查**时才可接受。从下面按推荐顺序选一个，并告诉用户选了哪个：

- **A. guest 字节码解释器（Tier 3/4 推荐）。** guest 变成一个小型寄存器指令集（或一个有界的 x86 子集）的程序，由 hypervisor 解释执行。每次 guest 的读、写、取指都经过 SLAT/EPT 遍历，于是 R/W/X、EPT violation、VM exit，以及 HVCI 的"不能执行未签名代码"都成为*真实*的属性，而不只是约定。这是唯一能让"执行权限"真正有意义的方案。它属于架构变更，先征得用户同意。
- **B. 每个分区 / 每个 VTL 独立的 wasm 实例。** 每个 guest 有自己的 `WebAssembly.Memory`，由 JS 在实例间路由超级调用。这借助 wasm 沙箱提供了真正的内存隔离。代价是每次跨分区访问都要绕一趟 JS，而且 GPADL 需要一个共享内存模型（复制，或者 SharedArrayBuffer；后者需要 COOP/COEP，`tools/serve.py` 已经发送了这些头）。
- **C. 保持共享镜像，但做静态检查。** 写一个测试或 CI 脚本：如果 `guest/guest.c`（或任何 VTL1/guest 编译单元）取了、或者直接引用了文档化入口（`hv_g_load`、`hv_g_store`、`hv_vmcall`、`hv_guest_log`）以外的任何 hypervisor 符号的地址，就失败。成本最低，对 Tier 2 够用，但不足以宣称具备 HVCI 语义。

无论选哪个，都要把它作为信任模型写进 HV_ABI.md，并加一个**尝试违规**的测试（VTL0 → VTL1 读、guest → 宿主读），断言它被拒绝或被检测到。

## 2. VSM / VTL 模型

每个 VP、每个 VTL 的状态（TLFS 的 "VSM" 部分）：
- 一套完整的寄存器上下文（VP 寄存器按 VTL 分组保存）；
- 每个 VTL 一个 SynIC（VTL1 有自己的 SINT）；
- 每个 VTL 的页保护：对每个更低的 VTL，每个 GPA 页有一个 `(R,W,X)` 掩码。

状态转换：
- `HvCallVtlCall`：VTL0 → VTL1。保存 VTL0 状态，加载 VTL1 状态，进入原因为 "VTL call"。
- `HvCallVtlReturn`：VTL1 → VTL0。
- 拦截：VTL0 的访问如果违反 VTL1 设置的保护，会**带着一条拦截消息进入 VTL1**（内存拦截，包含 GPA 和访问类型）。它绝不是一次单纯失败的超级调用。由 VTL1 决定是拒绝还是模拟。
- 更高 VTL 的中断会抢占更低 VTL 的执行。

启用顺序（分区没有 VSM 权限时全部拒绝）：`HvCallEnablePartitionVtl` → `HvCallEnableVpVtl`（提供初始的 VTL1 上下文）→ VTL1 安全内核初始化 → 用 `HvCallModifyVtlProtectionMask` 设置保护。

把 HVCI 作为 VTL1 的一项策略：VTL0 的内核请求 VTL1 把某页设为可执行。VTL1 用一个允许列表（代码完整性 / 签名校验的模型）检查页内容，然后把 VTL0 对该页的掩码设为 `R+X`，不带 `W`。之后 VTL0 任何想设置 `W` 的尝试 → 拦截 → 拒绝。测试必须覆盖：未签名 → 拒绝；已签名 → X；对 X 页尝试写 → 拦截并拒绝；对 W 页尝试执行 → 拦截并拒绝。

把 Credential Guard 作为一个 trustlet：秘密只存在于 VTL1 的页里。VTL0 通过一次安全调用请 LSAIso 做某个操作，拿回结果。测试扫描 VTL0 可访问的每个 GPA，必须找不到秘密的字节。

## 3. VT-x 模型

使用真实的 Intel SDM 名称和编码，让模型能对照手册检查：

- **VMCS** 是 hypervisor（宿主）内存里的一块区域，带有来自 `IA32_VMX_BASIC` 的 revision id。字段只能通过 VMREAD/VMWRITE 用真实编码访问（例如 `GUEST_RIP 0x681E`、`VM_EXIT_REASON 0x4402`、`EXIT_QUALIFICATION 0x6400`、`EPT_POINTER 0x201A`、`VIRTUAL_PROCESSOR_ID 0x0000`）。不要把结构体布局暴露成 ABI；在真实硬件上软件也不应该知道它。
- **启动状态机**：clear →（VMLAUNCH）→ launched；VMCLEAR 重置回 clear。VMfailInvalid / VMfailValid 的区分以及 VM 指令错误号都来自 SDM。
- **allowed-0/allowed-1 控制位**：必需的位不对时 VM entry 失败。这类测试写起来成本很低，数量可以很多。
- **退出流程**：guest 在指令边界停下 → exit reason 和 qualification 写入 VMCS → hypervisor 处理函数运行 → VMRESUME。这意味着 guest 的执行必须**能在某条指令处恢复**，这也是为什么 guest.c 目前对 `hv_vmcall()` 的直接 C 调用必须改成一次 exit。采用方案 A（解释器）时这很自然。在现有分阶段的 `gstep()` 模型里，一个"阶段"必须能在中途停下，这很别扭，所以这是选方案 A 的最有力理由。
- **EPT** 在 VT-x 模式下取代扁平的 `slat[]`：存放在 `PHYS` 里的真实 4 级页表遍历，每级 512 项，包含 R/W/X 权限位、内存类型和 A/D 位。违规产生 exit 48，qualification 带访问类型和表项权限位。非法组合（有 W 无 R）产生 exit 49。
- **TLB 语义**：建模一个以 (VPID, EPTP, GPA) 为键的小型转换缓存。重新映射后不执行 INVEPT/INVVPID，必须留下过期的表项。测试既要断言过期行为，*也*要断言失效之后被修复。完全跳过缓存是忠实度上的 bug，而不是简化。

### 嵌套（L0/L1/L2）

L1 的 VMX 指令会 exit 到 L0。L0 维护 VMCS12（L1 看到的视图），并通过合并控制位构建 VMCS02（实际运行 L2 用的）。L2 的 exit 如果 L1 没有要求，就由 L0 处理；如果要求了，就反射给 L1（作为 L1 的一次 VM exit，并更新 VMCS12）。Hyper-V 的 enlightened VMCS（eVMCS）是叠加在其上的优化，等普通嵌套能跑通之后再加。

## 4. 把现有 hypervisor 映射到 VT-x（最终形态）

| 现在 | VT-x 模式 |
|---|---|
| 直接调用 `hv_vmcall()` | VMCALL → exit reason 18 → 超级调用分发器 |
| `HC_QUERY_MSR` / `HC_SET_MSR` | RDMSR/WRMSR → exit 31/32（受 MSR bitmap 控制）；超级调用保留为 DEVIATION 兜底路径 |
| `HC_CPUID` | CPUID → exit 10 |
| 2 位的 `slat[]` | 带 R/W/X 的 EPT |
| VTL 保护 | 每个 VTL 一套 EPT（或权限叠加层），在 VTL 切换时切换 |
| `hv_schedule` 时间片 | VMX preemption timer，exit 52 |

在新路径通过完整的 hv_test 测试之前，保持旧路径可用。然后在一次改动里把 guest 切换过去，旧的超级调用帧 ABI 作为文档化的兼容接口保留。
