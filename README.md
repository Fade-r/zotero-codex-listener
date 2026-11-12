# Zotero Codex Listener

把 Zotero 的高亮、批注和论文条目下的笔记改动，直接送入指定的 Codex 会话。

需要 Windows、Zotero、Codex 桌面端和 [Node.js 22+](https://nodejs.org/)。

1. 从 [Releases](https://github.com/Fade-r/zotero-codex-listener/releases) 下载 `.xpi`，在 Zotero 插件管理器中选择“从文件安装插件”。
2. 打开 PDF，点击 **○ 监听** 旁的 **▾**，粘贴目标会话的 `codex://threads/…` 链接、ID 或 Markdown 链接。
3. 单击“监听”开始，显示 **● 监听中**；再次单击停止。找不到 Node.js 时，在下拉菜单中填写其路径。

默认停止，一次监听一个 PDF。仅发送开启后的改动，无改动时不调用模型。关闭 PDF 或连接出错后停止；重新开启不会补发遗漏的变化。已投递的消息仍可能继续处理。

在 **▾ → 发送延迟…** 中设置等待秒数，默认 1.5 秒；连续修改会重新计时，停下后合并发送。设置自动保存。

消息包含原文、批注、页码及增删改内容；图片注释仅传递位置等元信息。

**兼容性**：仅支持 Windows 本地会话，使用时保持一个 Codex 实例打开。依赖 Codex 桌面端内部接口，更新后可能需要适配。
