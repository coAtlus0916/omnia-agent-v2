# ADR-0023：Feature 必须携带四 Plane 实现文档并随安装发布到项目文档

状态：Accepted  
日期：2026-07-30  
决策来源：用户产品决策  
Refines：ADR-0001 的独立 Feature Package；ADR-0022 的 Shell-first 安装模型

## Context

独立 Feature 包如果只有代码、manifest 和测试，而没有与版本绑定的实现文档，后续维护者仍需从源码反推 Delivery、Execution、Control & Data、Integration 四个模块分别实现了什么。升级后，项目级文档也可能继续描述旧实现，重新形成 v4 中“文档声称”和“当前代码”混杂的问题。

用户要求：

1. 每个 Feature 记录其在每个模块中的功能实现；
2. 安装 Feature 时，把该 Feature 自己的文档写入项目文档。

## Decision

1. 每个 Feature Package 必须包含签名覆盖的 `docs/` 文档包；文档不是可选附件，而是安装一致性和 Definition of Done 的组成部分。
2. 每个 Feature 版本必须提供统一的四 Plane `Implementation Map`。每个用户能力/内部 capability 都要分别记录：
   - Delivery：菜单、视图、action、上传、状态订阅和用户交付；
   - Execution：Worker entry、步骤、算法/规则、Validator、资源和失败语义；
   - Control & Data：Run/Step/Event、repository command、数据 owner、迁移、确认、Artifact/Evidence；
   - Integration：Connector capability/operation ID、effect、预检、提交点、读回、Local/Remote；
   - 某 Plane 确实不参与时，必须写 `not_applicable` 和理由，不能留空。
3. Implementation Map 的每条记录至少绑定 `capabilityId/plane/responsibility/entrypoint/actionOrContractIds/dataOwner/effect/dependencies/testIds/status`，使文档可以被合同测试核对，不是自由文字概述。
4. 文档包必须同时包含：
   - 功能范围和非目标；
   - 四 Plane Implementation Map；
   - UI/action 与状态映射；
   - 数据、Schema、迁移、保留和删除；
   - Template/AI/Connector 依赖；
   - 安全权限和隐私边界；
   - 安装、升级、回滚和故障恢复；
   - 测试/canary 矩阵；
   - 版本变更记录和已知限制。
5. Package Manager 在 candidate 阶段校验文档 manifest、required 文件、digest、内部链接、编码、大小、locale、Feature/合同版本和敏感信息扫描。任一强制文档缺失、损坏、越权引用或与 manifest 不一致时，候选包失败，不注册菜单。
6. 安装器把验证后的不可变文档副本发布到项目级 Documentation Registry/Store，逻辑路径为：

   ```text
   project-docs/features/<featureId>/<featureVersion>/
   ```

   具体物理路径由未来 runtime/installer ADR 决定，Feature 包不能自行选择路径或写入项目文档目录。
7. 安装采用 **crash-safe staged install + atomic activation record**，不宣称文件复制、多个 Store migration、进程启动和 Registry 都属于一个 ACID 事务。Feature Registry 与 Documentation Registry 从同一 activation record 投影 active/previous/candidate：
   - active Feature 只能指向相同 `featureId/featureVersion/documentationDigest` 的 active 文档；
   - candidate 失败不写 activation record，候选文档仍不可见；
   - 回滚代码时同时回滚 active 文档指针；
   - 历史 Run 继续引用其精确 Feature 和文档版本。
8. 项目文档首页由 Documentation Registry 生成已安装 Feature 索引，显示安装状态、active/previous 版本、文档版本、健康和可用范围。运行状态仍以 Core/Feature Registry 为事实，文档不能自报“已安装/健康/成功”。
9. 升级和卸载规则：
   - 文档变更也需要新的 Feature patch 版本和新签名，不能原地修改已安装文档；
   - 卸载 Feature 后，active 入口移除，但历史版本文档按 Run/Evidence 保留策略继续可查；
   - 清除历史文档是独立的数据治理动作，不能由卸载隐式删除。
10. 文档禁止包含 Secret、Cookie、Authorization、客户正文、真实生产 ID、绝对生产路径、私钥位置或未脱敏诊断。代码符号只能使用仓库内逻辑定位和版本，不记录开发机绝对路径。
11. 当前开发前总体设计文档不是任何未实现 Feature 的安装文档。只有真实包完成并通过门禁后，才在项目 Documentation Registry 中产生该版本的“已安装 Feature 文档”，禁止预先生成假安装记录。

## Consequences

- Shell Baseline 必须包含 Documentation Registry/Store、文档校验器和项目文档索引生成能力。
- Feature 的实现和文档必须在同一版本、同一签名和同一 staged 发布单元中交付；对外可见性由单一 activation record 原子切换。
- 四 Plane 边界可以逐 capability 审计；新开发者不必从代码猜责任。
- 文档缺陷会阻止候选晋升，增加发布成本，但避免安装可运行而不可维护、不可审计的 Feature。
- 项目文档保留多个 Feature 版本；需要内容寻址、去重、配额和保留策略。

## Alternatives

### 只维护 Feature README

无法完整记录四 Plane、数据、Connector、迁移和测试，也难以自动核对实现漂移。

### 安装后由开发者手工复制文档

会出现遗漏、版本错配和不可回滚，不能满足独立包的一致激活。

### 从代码自动生成全部文档

可以生成 API/Schema 索引，但无法替代业务范围、失败语义、安全取舍和 canary 说明。自动生成内容只能成为文档包的一部分。

## Verification

- [ ] 缺少任一强制文档或四 Plane Implementation Map 时安装失败；
- [ ] manifest action/schema/operation/migration 与 Implementation Map 的 ID 集合进行双向漂移检查；
- [ ] 安装成功后项目文档索引出现相同 Feature/文档版本；
- [ ] candidate 失败不污染 active 项目文档；
- [ ] 文件 staging、migration、Worker health 和 activation 的每个阶段发生崩溃/断电后，安装 journal 能幂等恢复或进入明确的 manual recovery；
- [ ] Feature 回滚同时恢复 previous 文档指针；
- [ ] 历史 Run 能解析其冻结 Feature 版本对应的文档；
- [ ] 断链、路径穿越、超大文档、恶意 Markdown/HTML 和 Secret 扫描测试通过；
- [ ] Feature A 的安装器不能覆盖 Feature B、Core 或人工维护的总体架构文档；
- [ ] 未安装 Feature 不会出现在“已安装功能文档”索引中。
