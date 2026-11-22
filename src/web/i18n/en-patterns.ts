/**
 * Parameterized Chinese -> English regex patterns covering all template literals
 * across src/web and src/admin.
 */
export function translatePatternZhToEn(
  trimmed: string,
  lookup: (s: string) => string | undefined,
): string | null {
  const tr = (s: string) => lookup(s.trim()) ?? s.trim();

  const rules: ReadonlyArray<[RegExp, (...args: string[]) => string]> = [
    // Relative & formatted dates/times
    [/^刚刚$/, () => 'Just now'],
    [/^(\d+)\s*分钟前$/, (_m, n) => `${n}m ago`],
    [/^(\d+)\s*小时前$/, (_m, n) => `${n}h ago`],
    [/^(\d+)\s*天前$/, (_m, n) => `${n}d ago`],
    [/^(\d+)\s*毫秒$/, (_m, n) => `${n} ms`],
    [/^(\d+)\s*秒$/, (_m, n) => `${n}s`],
    [/^(\d+)\s*分$/, (_m, n) => `${n}m`],
    [/^剩余\s*(\d+)\s*秒$/, (_m, n) => `${n}s left`],
    [/^(\d+)\s*秒后更新$/, (_m, n) => `Updates in ${n}s`],
    [/^昨天\s+(\d{1,2}:\d{2})$/, (_m, t) => `Yesterday ${t}`],
    [/^(\d{1,2})月(\d{1,2})日\s+(\d{1,2}:\d{2})$/, (_m, mo, d, t) => `${mo}/${d} ${t}`],
    [/^(\d{1,2})月(\d{1,2})日$/, (_m, mo, d) => `${mo}/${d}`],
    [/^今天\s+(.+?)\s+自动重置$/, (_m, t) => `Resets today at ${t}`],
    [/^(.+?)\s+自动重置$/, (_m, t) => `Resets ${t}`],

    // Appearance & language hints
    [/^随设备自动切换，当前为(浅色|深色)。$/, (_m, m) => `Follows system appearance (currently ${m === '浅色' ? 'Light' : 'Dark'}).`],
    [/^始终使用(浅色|深色)模式。$/, (_m, m) => `Always uses ${m === '浅色' ? 'Light' : 'Dark'} mode.`],
    [/^当前使用(.+)界面。$/, (_m, l) => `Currently using ${l} interface.`],
    [/^随系统语言切换，当前为(.+)。$/, (_m, l) => `Follows browser language (currently ${l}).`],
    [/^最多保存\s*(\d+)\s*个自定义主题$/, (_m, n) => `Up to ${n} custom themes`],
    [/^已导入\s*(\d+)\s*个主题，可在对应模式中选择$/, (_m, n) => `Imported ${n} theme(s) into their matching mode`],
    [/^删除“(.+)”？$/, (_m, name) => `Delete "${tr(name)}"?`],

    // Messaging & conversations
    [/^(\d+)\s*条未读$/, (_m, n) => `${n} unread`],
    [/^(\d+)\s*人已读$/, (_m, n) => `Read by ${n}`],
    [/^共\s*(\d+)\s*条(?:消息|记录)?$/, (_m, n) => `${n} items`],
    [/^@([^\s·]+)\s*·\s*(Agent|联系人)$/, (_m, u, k) => `@${u} · ${k === 'Agent' ? 'Agent' : 'Contact'}`],
    [/^(.+)通话$/, (_m, label) => `${tr(label)} Call`],
    [/^助手发来(.+)通话$/, (_m, label) => `Incoming ${tr(label)} call from Agent`],
    [/^发送表情\s+(.+)$/, (_m, name) => `Send sticker ${name}`],
    [/^收藏表情\s+(.+)$/, (_m, name) => `Save sticker ${name}`],
    [/^移除表情\s+(.+)$/, (_m, name) => `Remove sticker ${name}`],
    [/^创建群聊\s*\((\d+)\)$/, (_m, n) => `Create Group (${n})`],

    // Workbench, models, tools, progress
    [/^当前模型：(.+?)（点击为下一条消息切换模型）$/, (_m, lbl) => `Model: ${lbl} (click to switch for next message)`],
    [/^当前模型：(.+?)（点击修改）$/, (_m, lbl) => `Model: ${lbl} (click to change)`],
    [/^查看\s*(\d+)\s*项工具活动$/, (_m, n) => `View ${n} tool activities`],
    [/^查看\s*(\d+)\s*项处理进度$/, (_m, n) => `View ${n} progress items`],
    [/^排队消息\s*·\s*(\d+)$/, (_m, n) => `Queued Messages · ${n}`],
    [/^新建\s+(.+?)\s+会话$/, (_m, name) => `New ${name} Session`],
    [/^(.+?)的最近会话$/, (_m, name) => `Recent sessions on ${name}`],
    [/^已答\s*(\d+)\/(\d+)$/, (_m, a, b) => `Answered ${a}/${b}`],
    [/^第\s*(\d+)\s*条提问：(.+)$/, (_m, i, lbl) => `Turn #${i}: ${lbl}`],
    [/^第\s*(\d+)–(\d+)\s*行$/, (_m, a, b) => `Lines ${a}–${b}`],
    [/^第\s*(\d+)\s*行$/, (_m, a) => `Line ${a}`],
    [/^剩余\s*(\d+(?:\.\d+)?)%$/, (_m, p) => `${p}% remaining`],
    [/^(.+?)\s+用量，(.+?)剩余\s*(\d+(?:\.\d+)?)%$/, (_m, n, s, p) => `${n} usage · ${s} ${p}% left`],
    [/^(.+?)\s+用量$/, (_m, n) => `${n} usage`],
    [/^(.+?)\s+剩余额度$/, (_m, n) => `${n} remaining`],
    [/^(.+?)\s+上传进度$/, (_m, n) => `${n} upload progress`],
    [/^插件\s*·\s*(.+)$/, (_m, s) => `Plugin · ${s}`],
    [/^端口\s*(\d+)$/, (_m, p) => `Port ${p}`],
    [/^网络连接\s*·\s*(.+)$/, (_m, rest) => `Network · ${rest.replace(/高延迟/g, 'High latency').replace(/毫秒/g, 'ms')}`],
    [/^(\d+(?:\.\d+)?)%\s*·\s*最近\s*(\d+)\s*次$/, (_m, p, n) => `${p}% · last ${n} probes`],
    [/^(.+?)已收到回答，正在同步…$/, (_m, l) => `${tr(l)} received answer, syncing…`],
    [/^(发送|操作)结果待确认$/, (_m, k) => `${k === '发送' ? 'Send' : 'Action'} pending confirmation`],
    [/^草稿已保留，请先核对状态，避免重复(发送|操作)。$/, (_m, k) => `Draft kept — check status before retrying ${k === '发送' ? 'send' : 'action'}.`],
    [/^请先核对状态，避免重复(发送|操作)。$/, (_m, k) => `Check status before retrying ${k === '发送' ? 'send' : 'action'}.`],
    [/^解除与\s+(.+?)\s+的配对并移除此浏览器的缓存？$/, (_m, n) => `Unpair ${n} and clear its browser cache?`],
    [/^附件操作：(.+)$/, (_m, n) => `Attachment actions: ${n}`],
    [/^放大预览：(.+)$/, (_m, n) => `Zoom preview: ${tr(n)}`],
    [/^在\s+(.+?)\s+继续$/, (_m, host) => `Continue on ${host}`],
    [/^请求失败\s*\((\d+)\)$/, (_m, code) => `Request failed (${code})`],
    [/^未提交成功：(.+)$/, (_m, err) => `Submission failed: ${tr(err)}`],
    [/^未能(.+)$/, (_m, act) => `Failed to ${tr(act).toLowerCase()}`],
    [/^正在加载\s+(.+)$/, (_m, x) => `Loading ${tr(x)}`],
    [/^正在读取(.+)…$/, (_m, x) => `Loading ${tr(x)}…`],
    [/^读取(.+)失败$/, (_m, x) => `Failed to load ${tr(x)}`],
    [/^正在(.+)…$/, (_m, x) => `${tr(x)}…`],
    [/^找到\s*(\d+)\s*个(.+)$/, (_m, n, l) => `Found ${n} ${tr(l)}`],
    [/^搜索(.+)或用途$/, (_m, l) => `Search ${tr(l)} or purpose`],
    [/^搜索(.+)$/, (_m, l) => `Search ${tr(l)}`],
    [/^打开\s+(.+)$/, (_m, n) => `Open ${n}`],
    [/^关闭(.+)$/, (_m, n) => `Close ${tr(n)}`],
    [/^添加(浅色|深色)主题$/, (_m, m) => `Add ${m === '浅色' ? 'Light' : 'Dark'} Theme`],
    [/^添加(.+)$/, (_m, n) => `Add ${tr(n)}`],
    [/^查看\s+(.+?)\s+详情$/, (_m, n) => `View ${n} details`],
    [/^移除插件\s+(.+)$/, (_m, n) => `Remove plugin ${n}`],
    [/^移除\s+(.+)$/, (_m, n) => `Remove ${n}`],
    [/^选择(.+)$/, (_m, n) => `Select ${tr(n)}`],
    [/^导出(.+)$/, (_m, n) => `Export ${tr(n)}`],
    [/^编辑(.+)$/, (_m, n) => `Edit ${tr(n)}`],
    [/^删除(.+)$/, (_m, n) => `Delete ${tr(n)}`],
    [/^在(.+)支持$/, (_m, n) => `Support on ${tr(n)}`],
    [/^(.+)的赞赏码$/, (_m, n) => `${n}'s Reward QR`],

    // Resource cleanup & export notices
    [/^已清理\s*(\d+)\s*个文件。消息文字和账户密钥已保留。$/, (_m, n) => `Cleaned ${n} file(s). Messages and keys were preserved.`],
    [/^已清理\s*(\d+)\s*个文件，其余尚未完成：(.+)$/, (_m, n, e) => `Cleaned ${n} file(s); remaining failed: ${tr(e)}`],
    [/^已生成\s*(\d+)\s*个文件的下载包，请在浏览器下载列表确认保存。云端文件未删除。$/, (_m, n) => `Exported ${n} file(s). Save from browser downloads; cloud files were not deleted.`],
    [/^已导出\s*(\d+)\s*个文件；(\d+)\s*个未能解密或读取.*$/, (_m, ok, fail) => `Exported ${ok} file(s); ${fail} could not be decrypted or read.`],

    // Admin console dynamic strings
    [/^UID\s*(\d+)\s*·\s*管理员$/, (_m, id) => `UID ${id} · Admin`],
    [/^会话\s+#([a-f0-9]+)$/i, (_m, id) => `Session #${id}`],
    [/^7天附件\s+(.+)$/, (_m, s) => `7d Attachments ${s}`],
    [/^永久头像\s+(.+)$/, (_m, s) => `Avatars ${s}`],
    [/^永久表情包\s+(.+)$/, (_m, s) => `Stickers ${s}`],
    [/^待清理\s*(\d+)\s*项$/, (_m, n) => `${n} pending cleanup`],
    [/^累计\s*(\d+)\s*·\s*已吊销\s*(\d+)$/, (_m, a, b) => `Total ${a} · Revoked ${b}`],
    [/^强制下线\s+(.+)$/, (_m, n) => `Force Sign Out ${n}`],
    [/^永久删除账号\s+(.+)$/, (_m, n) => `Permanently Delete ${n}`],
    [/^已永久删除账号\s+(.+?)\s+\(UID\s*(\d+)\)$/, (_m, n, id) => `Permanently deleted ${n} (UID ${id})`],
    [/^已吊销\s+(.+?)\s+的\s*(\d+)\s*个会话$/, (_m, n, c) => `Revoked ${c} session(s) for ${n}`],
    [/^已踢出\s+(.+?)\s+的设备会话$/, (_m, n) => `Revoked device session for ${n}`],
    [/^吊销桌面节点「(.+)」$/, (_m, n) => `Revoke Desktop "${n}"`],
    [/^已吊销桌面节点「(.+)」$/, (_m, n) => `Revoked desktop "${n}"`],
    [/^清理完成：删除\s*(\d+)\s*条消息、(\d+)\s*个附件、回收\s*(\d+)\s*个对象$/, (_m, a, b, c) => `Cleanup complete: removed ${a} messages, ${b} attachments, ${c} objects`],
    [/^将吊销\s+(.+?)\s+\(@([^)]+)\)\s+的全部\s*(\d+)\s*个活跃登录会话。$/, (_m, n, u, c) => `This will revoke all ${c} active sessions for ${n} (@${u}).`],
    [/^确认彻底删除\s+(.+?)\s+\(@([^\s]+)\s*·\s*UID\s*(\d+)\)\s+及其全部云端会话与数据？此操作不可撤销。$/, (_m, n, u, id) => `Permanently delete ${n} (@${u} · UID ${id}) and all cloud sessions/data? This cannot be undone.`],
    [/^确认将\s+(.+?)\s+\(@([^)]+)\)\s+的「(.+)」强制下线？$/, (_m, n, u, d) => `Force sign out "${d}" for ${n} (@${u})?`],
    [/^确认吊销属于\s+(.+?)\s+的桌面适配器（(.+?)）？吊销后该电脑将立即断开中继连接。$/, (_m, owner, hid) => `Revoke desktop adapter (${hid}) owned by ${owner}? It will disconnect immediately.`],
  ];

  for (const [pattern, replacer] of rules) {
    const match = trimmed.match(pattern);
    if (match) return replacer(...match);
  }
  return null;
}
