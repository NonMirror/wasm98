<!-- 中文审阅版，对应 ../references/pitfalls.md -->
# 坑点

大致按踩到的频率排序。每条写了你会看到的症状和应对方法。

## 构建与验证

1. **构建失败会删掉二进制。** `wasm-ld` 缺失或失败时，clang 会删除 `web/wasm/*.wasm`，`git status` 显示 `D`。这时测试加载失败；如果你把它恢复了，测试就会对着*旧*二进制通过。处理：用 `git checkout -- web/wasm/X.wasm` 恢复，弄好能用的链接器，并且构建失败之后的绿色测试结果绝不算验证。
2. **Homebrew 的 `llvm` 不带 `wasm-ld`。** 链接时会看到 `posix_spawn failed: No such file or directory`。安装 `lld`。
3. **测试就是规格，检查数只能涨。** 两套测试都会打印 `ALL GREEN — N checks passed`。N 变少说明你删掉或跳过了断言。不要为了让新代码通过而放宽现有断言；要么修代码，要么把 ABI 变更上报给用户。
4. **文档漂移。** HV_ABI.md 说 `build_kernel.sh` 会构建两个镜像，实际上不会：hypervisor 用的是 `build_hv.sh`。改 HV_ABI.md 时顺手修正发现的漂移，并让文档和字段编号保持一致。

## wasm32 / freestanding C

5. **`--export-all` 会泄露内部函数。** 任何非 `static` 的辅助函数都会变成 ABI，还可能在同一镜像的两个编译单元之间（kernel.c+nt.c、hv.c+guest.c）发生符号冲突。默认用 `static`。
6. **跨边界的 64 位值。** `u64` 导出在 JS 里是 BigInt。旧的胶水代码对它做 `x >>> 0` 会抛 `TypeError`，或者悄悄截断。边界上只用 32 位。
7. **隐式的 memcpy/memset。** 结构体赋值（`SynicMsg m = *src;`）和大型局部变量的 `= {0}` 会生成函数调用。在 `-nostdlib` 下，这些函数必须在镜像内部定义，否则链接失败。未解析的 import 也会让 `instantiate(bytes, {})` 抛异常。
8. **栈只有 1 MB。** 在递归遍历（对象命名空间、注册表枚举、嵌套 VM）里放大的局部变量（256 字节的 `SynicMsg`、行缓冲、VMCS 结构体），可能悄悄溢出到静态数据区。没有保护页，所以结果是状态被破坏而不是陷入。用迭代实现，大缓冲区放成 static。
9. **内存预算。** hypervisor.wasm 固定 32 MB（initial = max），光 `PHYS` 就占 16 MB。给每个 VP 加状态（VMCS、VTL 上下文、虚拟 APIC），乘以 16 个 VP 再乘以 N 个 VTL，涨得很快。往 `Vp` 里加结构体前先算一下。
10. **过期的 typed array 视图。** kernel.wasm 可能扩容，扩容会让旧的 `memory.buffer` 失效（detach）。跨调用缓存的 `Uint8Array` 之后会读出全零或者抛异常。每次都重新取视图。
11. **整数语义。** 像 `0xC0000022` 这样的 NTSTATUS 从 `i32` 导出返回到 JS 时是负数。现有测试是和负数比较的（`-1073741790`）。每个导出选定一种约定并写进文档；状态码混用 `u32` 和 `i32` 返回，是断言失败的常见来源。

## 语义建模

12. **主线程，不能阻塞。** 一个自旋到被唤醒为止的"等待"会冻结整个桌面。等待的做法是把线程登记为在该 dispatcher 对象上 Waiting，再由 `k_tick` 里的 signal、超时或 alert 路径唤醒。hypervisor 同理：VP "halt" 是设置一个状态，而不是进入循环。
13. **单个 tick 里的工作量没有上界。** DPC 排空、APC 投递、VM entry、标签页在后台之后的定时器追赶（`elapsed` 很大）都必须有预算。标签页从后台回来、`elapsed = 600000` 时，不能跑 60 000 次定时器回调。要钳制，并记为丢失的 tick。
14. **IRQL 规则必须强制执行，而不是只写在文档里。** 新机制要接入现有的 IRQL 检查：pushlock 和分页池操作只能在 DISPATCH 以下；spinlock 会把 IRQL 提到 DISPATCH；在 DISPATCH 及以上等待要 bugcheck（`IRQL_NOT_LESS_OR_EQUAL 0x0A`）或返回拒绝状态码。复用现有的违规计数器。
15. **引用计数。** 每种新对象类型都必须走 `k_obj_create`/`ref`/`deref`。句柄持有引用；进行中的等待、定时器、IRP 也持有引用。典型的泄漏症状：循环测试里 `k_obj_count()` 不断上涨。典型的 UAF 症状：仍有等待者指向某个槽位时，这个槽位被复用了。写一个"创建/关闭"循环测试，断言对象数回到基线。
16. **固定大小的表会复用 id。** id 就是槽位下标，所以 JS 手里一个过期的 id 可能悄悄命中一个新对象。在要紧的地方（句柄、分区、通道），给 id 加上代数/序列号，不匹配就拒绝，就像 NT 句柄表那样。
17. **快照格式。** `KFS1`/`KREG1` 保存在用户的 IndexedDB 里。给 hive 加功能（新的值类型、键上的安全描述符、快照里的事务）需要新的版本标记和向后兼容的加载逻辑。测试方法：加载一个由当前 HEAD 构建生成的快照字符串。
18. **不要伪造计数器。** UI 上能看到的计数器（任务管理器、Hyper-V 管理器）必须统计模型里真实发生的事件。事件没发生就让计数器加一，就是 mock，而本项目明确拒绝 mock（见 CONTRACT.md 的 "not a mock"）。

## Hypervisor 专项

19. **guest 和 hypervisor 共用线性内存。** guest.c 链接在 hv.c 的镜像里。它的隔离之所以成立，只是因为 guest.c 自觉使用 `hv_g_load`/`hv_g_store`（共 22 处调用），从不拿指向 `PHYS` 的裸指针。canary 页只能事后发现*部分*违规。任何解引用宿主指针的新 guest 代码，都会在看不见的情况下破坏安全模型。见 vbs-vtx.md §1。
20. **缺少权限检查。** 超级调用分发器（`hv_vmcall`，在 `hypervisor/hv.c` 约 1354 行）对创建分区、存入内存、映射 GPA、创建 VP 都不检查分区权限。照着这些 case 复制出来的新特权超级调用会继承同样的漏洞。
21. **SLAT 编码只有 2 位。** `(pfn << 2) | flags`。加执行位意味着要改移位量，所有 `>> 2` 和 `& 3u` 的地方都必须在同一次提交里改掉。先全部 grep 出来，然后加一个测试，逐一读回 `hv_gpa_state` 文档里约定的每个值。
22. **GPA 空间很小。** `GPA_PAGES = 176`（每个分区 704 KB），固定布局（超级调用页 0xE000、FB 0x10000、环 0x80000/0x88000、SIMP 0x90000、SIEFP 0x91000、TSC 0x92000）在 hv.c 和 guest.c 里都是硬编码。移动任何一项都要两边一起改，外加 hv_test.mjs。新页（VTL1 内存、VMCS 区域、APIC 页）分配在现有页之上，并记进 HV_ABI.md。
23. **真实 TLFS 编号与本地编号。** 现有超级调用号是"仿 Hyper-V"的，但不全是真实编号（真实的 `HvCallPostMessage` 确实是 0x005C，但这里的 `HvCallCreatePartition` 是 0x0040 只是约定）。新调用用真实的 TLFS 编号。如果和现有本地编号冲突，保留本地编号并加 DEVIATION 注释，不要重新编号。
24. **root 和子分区的角色。** root 分区是 1 号，并且是特判的（`is_root` 在 start/stop/delete 里提前返回）。新的生命周期代码（保存/恢复、检查点、启用 VTL）必须明确它对 root 意味着什么，不适用时要显式拒绝。
