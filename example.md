下面整理的是截至 **2026-10-14** 能找到、README 中有明确功能说明的 mod 版 fork、整合包或独立 Mod 项目。分支列的是**当前默认分支**；有特征开发分支的，会特别标出。`main` / `master` 仅表示项目当前主分支，不代表该项目能与其他模组直接叠加。

### 大型改版与整合包

| 项目 | 修改分支 | 特色 |
|---|---|---|
| [乐勒砳特供](https://github.com/llleeeqi/Stronghold-Protocol-Lele-Mods) | [`main`](https://github.com/llleeeqi/Stronghold-Protocol-Lele-Mods/tree/main) | 基于固定上游构建整合版本；包含更多阵营、收藏品、新干员、伤害统计、随机开局、定向甄选等**八项默认关闭**的房间拓展。采用补丁和数据生成器构建，不是运行时插件加载器。 |
| [莱茵生命扩展](https://github.com/YUYUYUYUYUYUYUTOUA/Stronghold-Protocol-Rhine) | [`codex/rhine-upstream-021`](https://github.com/YUYUYUYUYUYUYUTOUA/Stronghold-Protocol-Rhine/tree/codex/rhine-upstream-021) | 莱茵生命与卡兹戴尔内容：新干员、盟约、科研装置、装备套装及相关战斗机制。大型源码扩展。 |
| [罗德岛 / 卡兹戴尔盟约 Mod](https://github.com/yznx09/Stronghold-Protocol-Rhodes-Kazdel-Mod) | [`main`](https://github.com/yznx09/Stronghold-Protocol-Rhodes-Kazdel-Mod/tree/main) | 面向 v0.2.4 的整包及拆分包，包含卡兹戴尔、罗德岛等阵营，以及图鉴、练度、商店权重、整备期换技能等功能。拆分包之间有重叠，不宜随意组合。 |
| [Infinity 改版](https://github.com/Mizuki-OvO/Stronghold-Protocol-Infinity) | [`main`](https://github.com/Mizuki-OvO/Stronghold-Protocol-Infinity/tree/main) | 无尽模式、特殊道具和本地数值修改器；属于独立改版，README 提醒其不是上游发布包。 |
| [20 人容量分支](https://github.com/LongQianChen/Stronghold-Protocol) | [`feat/IncreasePlayerCapacity`](https://github.com/LongQianChen/Stronghold-Protocol/tree/feat/IncreasePlayerCapacity) | 同盟房间扩至 20 席，并调整分组轮选等多人流程；影响房间和联防逻辑，属于大范围改动。 |
| [扩展版 Stronghold-Protocol](https://github.com/zhewang448/Stronghold-Protocol) | [`main`](https://github.com/zhewang448/Stronghold-Protocol/tree/main)；另有 [`codex/release-v0.2.6-extended.3`](https://github.com/zhewang448/Stronghold-Protocol/tree/codex/release-v0.2.6-extended.3) | 主机控制台、休整期回档、逐回合统计、联动自选干员和可选皮肤；有独立发行版与版本分支。 |
| [社区融合维护版](https://github.com/AlexandraPeng/Stronghold-Protocol) | [`main`](https://github.com/AlexandraPeng/Stronghold-Protocol/tree/main) | 网页与 Android 离线/联机，融合社区技能和修复，也有多人容量改动；需留意 README 中的基础版本信息与当前上游是否一致。 |
| [内容包与容量改动 fork](https://github.com/daa0v0/Stronghold-Protocol) | [`master`](https://github.com/daa0v0/Stronghold-Protocol/tree/master) | 实现 `data` / `assets` 内容包方向，并包含多人容量等扩展；其中源码改动与其他玩法 fork 可能重叠。 |

### 单项玩法、内容包与补丁

| 项目 | 修改分支 | 特色 |
|---|---|---|
| [丰川祥子 / 自选干员 fork](https://github.com/bmryggdrasil/Stronghold-Protocol) | [`deploy/custom`](https://github.com/bmryggdrasil/Stronghold-Protocol/tree/deploy/custom)；另有 [`feat/op-oblvns`](https://github.com/bmryggdrasil/Stronghold-Protocol/tree/feat/op-oblvns) | 新增丰川祥子、结城理等干员，并包含其他干员实现与修复。 |
| [丰川祥子 Mod](https://github.com/LimitlessHPPK/Stronghold-Protocol-Sakiko-Mod) | [`main`](https://github.com/LimitlessHPPK/Stronghold-Protocol-Sakiko-Mod/tree/main) | 丰川祥子自选编队，以及地图缩放/平移、音效修复、模组攻速词条修复等；README 描述的基线是 v0.2.1，移植到新版前需核实。 |
| [收藏品 DLC](https://github.com/UNDFFIO/Stronghold-Protocol-dlc) | [`master`](https://github.com/UNDFFIO/Stronghold-Protocol-dlc/tree/master) | 战后收藏品奖励、逆风补给、护盾及局内增益；已被乐勒砳选择性移植整合。 |
| [新干员包](https://github.com/remember-4/Stronghold-Protocol-Rem) | [`master`](https://github.com/remember-4/Stronghold-Protocol-Rem/tree/master) | 结城理、娜仁图亚、予愿安洁莉娜、丰川祥子等干员及技能/模组内容；被乐勒砳选择性移植。 |
| [额外干员包](https://github.com/Lunac1a/Stronghold-Protocol) | [`master`](https://github.com/Lunac1a/Stronghold-Protocol/tree/master) | 望、赤刃明霄陈、凯尔希·思衡托、维什戴尔等干员；与其他干员包有重复内容，需要协调注册和数据。 |
| [伤害统计 fork](https://github.com/Stardust-minus/Stronghold-Protocol) | [`master`](https://github.com/Stardust-minus/Stronghold-Protocol/tree/master) | 统计实际扣血排行，并处理召唤物与干员归属；相关功能被整合进乐勒砳版本。 |
| [恭喜发财 / 随机开局](https://github.com/RiZhiZhaoYi/Stronghold-Protocol) | [`master`](https://github.com/RiZhiZhaoYi/Stronghold-Protocol/tree/master) | 每个席位随机获得不同五阶开局干员，同时消耗共享卡池；相关玩法被乐勒砳选择性移植。 |
| [定向甄选](https://github.com/Strinova-xinghui/Stronghold-Protocol) | [`master`](https://github.com/Strinova-xinghui/Stronghold-Protocol/tree/master) | 晋升奖励和转职装备按主要盟约提高权重；相关逻辑被乐勒砳移植并加开关。 |
| [Typography & Damage FX 补丁](https://github.com/ZizhaoNi/Stronghold-Protocol-Typography-Patch) | [`main`](https://github.com/ZizhaoNi/Stronghold-Protocol-Typography-Patch/tree/main) | 字体与界面自定义，并涉及暴击反馈、元素伤害拆分；它是独立补丁项目，不能仅凭功能描述判断与其他版本兼容。 |

**对你们的模组目录最有参考价值**的，是乐勒砳的整合仓库和 yznx 的拆分包仓库：前者展示了“先维护者整合，再由房间开关选择玩法”，后者则说明即便功能已拆成独立包，改动重叠时仍需要整包或人工兼容。上表是候选项目索引，**不等于这些项目都能直接安装到当前启动器，也不表示它们彼此兼容**。