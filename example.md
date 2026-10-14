# 社区整合版 / Fork 体验列表

启动器现在按「版本」管理游戏：**一个仓库分支就是一个独立版本**，代码和依赖各自隔离，游戏素材可共用。想体验某个社区改版时，在启动器的「版本」页添加表格中的仓库地址与分支，安装后切换到该版本启动即可。

> 这些项目是社区维护的非官方版本，不代表上游作者参与或认可。每个版本独立运行；启动器不会把多个 fork 的改动合并到一起，也不会把下面项目的功能叠加到原版或其他 fork 上。版本基线、素材需求和维护状态以各项目说明为准。

## 可作为独立版本安装的项目

| 项目 | 仓库 | 添加时填写的分支 | 特色 / 适合体验 |
|---|---|---|---|
| 莱茵生命扩展 | [Stronghold-Protocol-Rhine](https://github.com/YUYUYUYUYUYUYUTOUA/Stronghold-Protocol-Rhine) | [`codex/rhine-upstream-021`](https://github.com/YUYUYUYUYUYUYUTOUA/Stronghold-Protocol-Rhine/tree/codex/rhine-upstream-021) | 莱茵生命与卡兹戴尔阵营、科研装置、新干员和装备套装。玩法扩展较完整；属于改动范围较大的独立版本。 |
| 主机工具与皮肤扩展版 | [Stronghold-Protocol](https://github.com/zhewang448/Stronghold-Protocol) | [`main`](https://github.com/zhewang448/Stronghold-Protocol/tree/main) | 主机控制台、休整期回档、逐回合伤害统计、联动自选干员和可选皮肤。仓库也维护 `codex/release-v0.2.6-extended.3` 等发行分支；如需固定发行版本，可按项目 Releases 说明选择对应分支/版本。 |
| 社区融合版（含 Android） | [Stronghold-Protocol](https://github.com/AlexandraPeng/Stronghold-Protocol) | [`main`](https://github.com/AlexandraPeng/Stronghold-Protocol/tree/main) | 网页联机与 Android 离线/联机，融合社区技能、阿戈尔修复，并有多人容量相关改动。请先看 README 确认当前分支的基础版本和构建方式。 |
| Infinity 无尽改版 | [Stronghold-Protocol-Infinity](https://github.com/Mizuki-OvO/Stronghold-Protocol-Infinity) | [`main`](https://github.com/Mizuki-OvO/Stronghold-Protocol-Infinity/tree/main) | 无尽模式、特殊道具和本地数值修改器。玩法规则与原版差异较大；项目说明为源码运行，未必提供可直接下载的完整包。 |
| 20 人容量实验分支 | [Stronghold-Protocol](https://github.com/LongQianChen/Stronghold-Protocol) | [`feat/IncreasePlayerCapacity`](https://github.com/LongQianChen/Stronghold-Protocol/tree/feat/IncreasePlayerCapacity) | 将同盟容量扩展到 20 人，并调整多人分组/轮选等流程。多人规则改动较大，适合专门体验容量扩展。 |
| 内容包扩展分支 | [Stronghold-Protocol](https://github.com/daa0v0/Stronghold-Protocol) | [`master`](https://github.com/daa0v0/Stronghold-Protocol/tree/master) | 实现 `data` / `assets` 内容包方向，并包含其他游戏改动。属于源代码扩展，不是只放入数据文件即可使用的普通资源包。 |
| 丰川祥子 / 结城理等干员扩展 | [Stronghold-Protocol](https://github.com/bmryggdrasil/Stronghold-Protocol) | [`deploy/custom`](https://github.com/bmryggdrasil/Stronghold-Protocol/tree/deploy/custom) | 增加丰川祥子、结城理等干员，并包含其他社区干员/修复。该分支有合并提交，作为一个整体版本安装，不要与其他 fork 的补丁叠加。 |
| 头像、预下载与房间管理改版 | [Stronghold-Protocol-Modded](https://github.com/Rosmontis220/Stronghold-Protocol-Modded) | [`master`](https://github.com/Rosmontis220/Stronghold-Protocol-Modded/tree/master) | 项目描述列出头像系统、资源预下载和踢出队友功能。安装前建议检查 README 中的版本要求及近期维护情况。 |

## 不是完整 Fork 的相关项目

以下项目有可用功能，但形式是单项补丁、安装包或修改器，并非可直接作为完整版本登记的上游游戏 fork；除非项目提供完整源码分支及明确安装说明，否则不要把它们当成「版本」页的仓库来添加。

| 项目 | 地址 | 内容 |
|---|---|---|
| 罗德岛 / 卡兹戴尔盟约 Mod | [Stronghold-Protocol-Rhodes-Kazdel-Mod](https://github.com/yznx09/Stronghold-Protocol-Rhodes-Kazdel-Mod) | 面向上游 v0.2.4 的整包和拆分包，含卡兹戴尔等阵营、图鉴、练度、商店权重等功能。它是对游戏目录应用补丁的 Mod 工具包，不是完整 fork；拆分包之间也有重叠。 |
| 丰川祥子本地修改版 | [Stronghold-Protocol-Sakiko-Mod](https://github.com/LimitlessHPPK/Stronghold-Protocol-Sakiko-Mod) | 丰川祥子自选编队、地图缩放/平移及若干修复。项目 README 标注基于 v0.2.1，添加前应确认目标分支能否在当前上游版本运行。 |
| Typography & Damage FX Patch | [Stronghold-Protocol-Typography-Patch](https://github.com/ZizhaoNi/Stronghold-Protocol-Typography-Patch) | 字体、界面配色、暴击反馈和元素伤害显示等补丁；不是完整上游 fork。 |

## 安装前请注意

- 在「版本」页添加时，仓库地址填项目 GitHub 页面，分支填表格指定值；留空仓库地址则代表上游原版。
- 首次启动 fork 仍需安装依赖并准备素材；耗时取决于下载源和项目说明。启动器共用素材目录，通常无需为每个版本重新下载一整份素材。
- 不同 fork 可能基于不同上游版本，不能仅凭启动器成功克隆就认定玩法、素材或联机协议兼容。
- 更新前先查看对应 fork 的更新记录；更新一个版本不会自动更新其他 fork。
- 社区版本可能包含不平衡或实验性玩法。遇到问题时，先切回原版或另一个独立版本进行对照。

本页是社区项目索引，不是兼容性认证。项目链接和分支信息最后核对于 **2026-10-14**；分支可能变更、删除或停止维护。