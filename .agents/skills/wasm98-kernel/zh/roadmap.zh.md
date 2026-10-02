<!-- 中文审阅版，对应 ../references/roadmap.md -->
# 路线图

自上而下推进。每项列出所在位置、"完成"的含义（要加的断言）和依赖。给出真实的 Windows 名称，让模型和真实系统对得上。

## Tier 0：基础（先于一切）

| # | 项目 | 位置 | 完成标准 |
|---|---|---|---|
| 0.1 | 可用的工具链 + 门禁 | tools/ | 两个构建都成功，两套测试全绿，`.wasm` 文件显示为已修改 |
| 0.2 | 强制执行分区权限掩码 | hv.c `hv_vmcall` | 子分区调用 CreatePartition / DepositMemory / MapGpaPages / CreateVp 得到 `HV_STATUS_ACCESS_DENIED`；root 仍然成功；CPUID 0x40000003 反映每个分区真实的掩码 |
| 0.3 | 带代数标记的 id | nt.c 句柄，hv.c 分区/通道 | 删除再重建后，过期 id 被拒绝 |
| 0.4 | 带 R/W/X 的 SLAT 表项 | hv.c | 用每种权限组合映射；读/写/执行检查报告对应的 fault；老调用方看到的 `hv_gpa_state` 不变 |
| 0.5 | 对象数泄漏测试 | 测试 | 1000 次创建/打开/关闭循环后，`k_obj_count()` 和句柄数回到基线 |

## Tier 1：现代 NT executive（kernel/nt.c）

| # | 机制 | 完成标准 |
|---|---|---|
| 1.1 | 对象管理器命名空间（`\`、`\Device`、`\BaseNamedObjects`、`\Sessions\N`、符号链接、`\??` → `\GLOBAL??`） | 按名创建/打开，`STATUS_OBJECT_NAME_COLLISION`、`…_NOT_FOUND`，带深度上限的链接解析（`STATUS_REPARSE` 环路被拒绝） |
| 1.2 | 真实的安全描述符：SID + ACE 列表、owner、DACL/SACL、带通用映射的 `SeAccessCheck`，特权（`SeDebugPrivilege`、`SeLoadDriverPrivilege` 等）作为令牌里的位 | deny ACE 优先于 allow；顺序有影响；没有特权时特权检查失败；现有单个 u32 的 DACL 作为兼容形式继续可用 |
| 1.3 | 强制完整性控制（Untrusted/Low/Medium/High/System），no-write-up | 即使 DACL 允许，Low 令牌也不能写 Medium 对象 |
| 1.4 | 受保护进程 / PPL（签名者级别） | 未受保护的调用方以 `PROCESS_VM_WRITE` 打开 PPL 时被拒绝，即使是管理员 |
| 1.5 | `WaitForMultipleObjects`（wait-any / wait-all），mutant 的 `STATUS_ABANDONED`，`STATUS_USER_APC` / `STATUS_ALERTED` | wait-all 要么全部获得要么都不获得；持有 mutant 的 owner 终止 → 下一个等待者得到 ABANDONED |
| 1.6 | spinlock + queued spinlock、ERESOURCE、pushlock、fast mutex / guarded mutex | 各自强制自己的 IRQL；对不可重入锁递归获取会 bugcheck 或被拒绝；ERESOURCE 和 pushlock 的共享/独占语义正确 |
| 1.7 | 线程调度细节：量子重置、前台提升、优先级类、N 个逻辑处理器上的 `KeSetAffinityThread`、idle 线程、理想处理器 | 每 CPU 就绪队列；亲和性被遵守；防饥饿提升仍然有效 |
| 1.8 | 定时器：带 DPC 的 `KTIMER`、周期定时器、高精度定时器、定时器合并（容差） | 容差窗口内的合并定时器在同一批里触发 |
| 1.9 | 工作项 / 系统工作线程（`IoQueueWorkItem`、`ExQueueWorkItem`） | 在 PASSIVE 运行；允许在 DISPATCH 入队，不允许在 DISPATCH 运行 |
| 1.10 | I/O 完成端口 + 异步 I/O（`STATUS_PENDING`、`IoMarkIrpPending`、cancel-safe 队列） | pending 的 IRP 之后通过端口完成；取消竞争恰好被处理一次 |
| 1.11 | ALPC 端口（connect / accept / message / reply，基于 section 的端口视图） | 请求/应答往返；服务端看到客户端令牌；端口关闭时等待者失败 |
| 1.12 | PnP 管理器 + 电源 IRP（`IRP_MN_START_DEVICE`、`QUERY_REMOVE`、`REMOVE`、D 状态） | 设备节点状态机；仍有句柄打开时拒绝移除 |
| 1.13 | 内存管理器：带页链表的 PFN 数据库（free/zeroed/standby/modified/active）、工作集修剪、页面文件（模型）、写时复制 section、VAD 树、大页、共享 section 的原型 PTE | 内存压力下 standby 页被重新利用；COW 写缺页得到私有副本；提交量统计保持精确 |
| 1.14 | 池：带标签的池、每进程池配额、`POOL_NX`、segment heap（模型） | 重复释放 / 错误标签 bugcheck `BAD_POOL_CALLER 0xC2`；配额被正确扣除和释放 |
| 1.15 | Job 对象 + silo | job 内存上限导致提交失败；kill-on-close 终止所有成员 |
| 1.16 | 注册表：真实的 hive cell / bin、基于 KTM 的事务、符号键（`CurrentControlSet`）、app hive | 快照往返不丢失（要带版本！）；KTM 回滚恢复值 |
| 1.17 | ETW（provider、session、环形缓冲区） | 来自调度器 / IO / MM 的事件进入 session 缓冲区，JS 可以取出 |
| 1.18 | Driver Verifier 风格的检查 + 更丰富的 bugcheck（`DRIVER_IRQL_NOT_LESS_OR_EQUAL 0xD1`、`KMODE_EXCEPTION`、`DRIVER_VERIFIER_DETECTED_VIOLATION 0xC4`） | 每条规则都有一个触发它并断言代码和参数的测试 |
| 1.19 | 内核补丁保护（PatchGuard 模型） | 对"关键结构"（分发表、IDT 模型）定期做完整性检查，被修改时 → `CRITICAL_STRUCTURE_CORRUPTION 0x109` |

## Tier 2：Hyper-V（hypervisor/hv.c、guest/guest.c）

遵循 Hypervisor Top-Level Functional Specification（TLFS）。

| # | 机制 | 完成标准 |
|---|---|---|
| 2.1 | 真实的超级调用输入格式：64 位控制字（调用号、fast 标志、rep 计数、rep 起始下标），rep 超级调用，新路径中使用真实编号的 `HV_STATUS_*` | 被预算打断的 rep 超级调用返回部分完成的 rep 计数并能继续；旧的 32 字节帧仍可用（以 DEVIATION 记录） |
| 2.2 | 分区属性 + `HvCallGetPartitionProperty` / `SetPartitionProperty`；按 TLFS 的分区权限掩码 | 每个分区有自己的掩码；子分区不能提升自己的权限 |
| 2.3 | 内存：存入/取回（`HvCallWithdrawMemory`），带访问类型的 GPA 映射，`HvCallGetGpaPagesAccessState`（脏页跟踪） | guest 写入设置脏位，查询时清除 |
| 2.4 | 完整的 SynIC：16 个 SINT、auto-EOI、消息 pending 标志 + EOM 重投递、SIEFP 中的事件标志、带 connection id 的 `HvCallSignalEvent`、带 port id 的 `HvCallPostMessage` | 消息槽满时设置 pending；EOM 触发重投递；被屏蔽 SINT 的丢弃被计数 |
| 2.5 | 每个 VP 的 synthetic timer 0..3（STIMERn_CONFIG/COUNT MSR），周期 + 单次，direct 模式 | 四个定时器独立触发；在 lazy 语义下，错过的周期触发被合并 |
| 2.6 | Reference TSC 页（scale/offset、序列号） | guest 从该页计算出的时间和 TIME_REF_COUNT 在容差内一致 |
| 2.7 | VP 寄存器：通过 Get/SetVpRegisters 按 `HV_REGISTER_NAME` 访问完整的 x64 寄存器集 | GPR、CR、EFER、段寄存器（作为数据）往返一致 |
| 2.8 | 虚拟 APIC / 合成中断控制器（EOI、ICR、TPR MSR 0x40000070-73），VP 间 IPI，`HvCallSendSyntheticClusterIpi`，刷新类超级调用（`HvCallFlushVirtualAddressSpace`） | 跨 VP 的 IPI 在目标 VP 下一次 entry 时投递 |
| 2.9 | 多 VP guest + SMP guest 调度、VP 亲和性、上限/权重（CPU group 模型） | 修改权重后，时间片占比在容差内按比例变化 |
| 2.10 | VMBus 协议：版本协商（`CHANNELMSG_INITIATE_CONTACT`）、offer、GPADL 建立/拆除、带中断屏蔽和 pending-send-size 的环形缓冲区、close/rescind | 关闭后可重新协商；打开状态下 rescind → guest 能看到 |
| 2.11 | 基于 VMBus 的合成设备：合成键盘、合成显示（framebuffer 作为 GPADL）、类 storvsc 的块设备、类 netvsc 的回环、心跳/关机/时间同步集成服务 | 集成服务显示在 Hyper-V 管理器里；关机集成服务让 guest 干净地停机 |
| 2.12 | 保存/恢复与检查点（分区状态序列化为带版本的格式） | 恢复后 framebuffer 完全相同，心跳继续 |
| 2.13 | 实时迁移模型（两个分区之间基于脏页跟踪的 pre-copy） | 能收敛；目标分区以相同的状态哈希恢复运行 |

## Tier 3：VBS（依赖 0.2、0.4、2.1、2.7），见 vbs-vtx.md

| # | 机制 | 完成标准 |
|---|---|---|
| 3.1 | VSM 能力 + VTL：`HvCallEnablePartitionVtl`、`HvCallEnableVpVtl`、`HvCallVtlCall` / `HvCallVtlReturn`、每个 VTL 的寄存器状态、VSM code page | VTL0 读不到 VTL1 的寄存器；进入/返回对称；按 VTL 分别计数 |
| 3.2 | VTL 内存保护：`HvCallModifyVtlProtectionMask`，每个 VTL、每个 GPA 页的 R/W/X | VTL0 写一个被 VTL1 设为只读的页 → 拦截到 VTL1，而不是悄悄成功 |
| 3.3 | 安全内核（VTL1）作为独立的 guest 镜像，拥有自己的状态 | 普通内核的请求只能通过 VtlCall 发出 |
| 3.4 | HVCI / 内存完整性：VTL1 通过 SLAT 强制 W^X；代码页只有在"签名"检查（模型：哈希允许列表）通过后才变为可执行 | 未签名的页不能设为 X；已经是 X 的页不能设为 W；尝试被记录并拒绝 |
| 3.5 | Kernel Data Protection（静态 + 动态 KDP） | 被保护区域对 VTL0 只读，内核自己也不例外 |
| 3.6 | Credential Guard / LSAIso 作为 VTL1 trustlet；带安全调用的 IUM trustlet | VTL0 只能拿到句柄或派生的数据块，永远拿不到秘密字节；测试证明扫描 VTL0 内存找不到秘密 |
| 3.7 | 安全启动链 + 度量启动模型（TPM PCR extend、启动日志） | 修改任何"启动组件"都会改变 PCR，VTL1 拒绝解封 |
| 3.8 | HyperGuard / 安全内核对 VTL0 关键寄存器的补丁保护（CR0/CR4/MSR 拦截） | VTL0 清除 CR0.WP 或 CR4.SMEP → 被拦截并拒绝 |

## Tier 4：Intel VT-x 模型（见 vbs-vtx.md §3）

| # | 机制 | 完成标准 |
|---|---|---|
| 4.1 | 能力 MSR：`IA32_FEATURE_CONTROL`（lock、SMX 外 VMX）、`IA32_VMX_BASIC`、pin/proc/exit/entry 控制 MSR 及 allowed-0/allowed-1 语义、CPUID.1:ECX.VMX | 未锁定 feature-control 就执行 VMXON → #GP(0)，以 fault 建模 |
| 4.2 | VMXON / VMXOFF、带 revision id 的 VMCS 区域、VMCLEAR / VMPTRLD / VMPTRST、按真实字段编码的 VMREAD / VMWRITE、启动状态 | 对已 launched 的 VMCS 执行 VMLAUNCH → VMfailValid，错误号 4（对非 clear 的 VMCS 执行 VMLAUNCH）；对 clear 的 VMCS 执行 VMRESUME → 错误号 5；错误字段 → 错误号 12 |
| 4.3 | VM entry 检查（控制位、宿主状态、guest 状态）→ VM entry 失败，exit reason 33 / 34 | 每一类检查至少有一个负向测试 |
| 4.4 | 使用真实基本 exit reason 的 VM exit（0 异常/NMI、1 外部中断、10 CPUID、12 HLT、18 VMCALL、28 CR 访问、30 I/O、31 RDMSR、32 WRMSR、48 EPT violation、49 EPT misconfig、52 preemption timer）+ exit qualification | 每个 exit reason 都由一个 guest 动作触发，处理后 guest 在正确的位置恢复 |
| 4.5 | EPT：hypervisor 内存里的 4 级页表，EPTP 格式（内存类型、遍历长度、A/D 使能），R/W/X 权限，EPT violation 的 qualification 位，INVEPT single/global | 配置错误的表项（有 W 无 R）→ exit 49；访问时设置 A/D 位 |
| 4.6 | VPID + INVVPID；TLB 模型（缓存的转换在失效前保持过期） | 重新映射后缺少 INVEPT → guest 观察到过期映射（没错，这才是正确语义） |
| 4.7 | 中断注入（VM entry interruption info）、interrupt-window exiting、posted interrupt | 注入在下一次 entry 时投递，并遵守 guest 的 IF |
| 4.8 | VMX preemption timer、MSR bitmap、I/O bitmap | 只有在 bitmap 中的 MSR 才会 exit |
| 4.9 | 嵌套虚拟化：执行 VMX 指令的 L1 hypervisor → L0 中的 shadow VMCS / VMCS12→VMCS02 合并；enlightened VMCS（Hyper-V 的 eVMCS） | L2 guest 能运行；只有当 L1 的控制位要求时，L2 的 exit 才被反射给 L1 |

Tier 4 完成后，把 Hyper-V 映射到 VT-x 上：现有 hypervisor 的超级调用变成 VMCALL exit（reason 18），MSR 访问变成 exit 31/32，SLAT 变成 EPT，VTL 保护变成每个 VTL 一套 EPT 权限。这个映射才是最终目标；不要在 hypervisor 旁边另外拼一个毫不相干的 "VT-x"。
