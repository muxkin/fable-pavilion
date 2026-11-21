import type { AdminStorageDetail } from '../shared/messaging';
import { Icon } from '../web/Icon';
import { tsxComponent } from '../web/tsx-component';
import { formatBytes, formatDateTime, formatNumber } from './format';

export const StorageView = tsxComponent(function StorageView(_props: {
  storage: AdminStorageDetail | null;
  cleaning: boolean;
  onCleanup: () => void;
}) {
  return ({ storage, cleaning, onCleanup }) => {
    if (!storage) {
      return <p class="adm-empty">正在读取存储明细…</p>;
    }
    const totalBytes = storage.files.bytes + storage.stickers.bytes + storage.avatars.bytes;
    const filePct = totalBytes ? (storage.files.bytes / totalBytes) * 100 : 0;
    const stickerPct = totalBytes ? (storage.stickers.bytes / totalBytes) * 100 : 0;
    const avatarPct = totalBytes ? (storage.avatars.bytes / totalBytes) * 100 : 0;

    return (
      <div class="adm-stack">
        <div class="adm-card">
          <div class="adm-card-head">
            <div>
              <h2>云端存储与 7 天留存治理</h2>
              <p class="adm-muted">
                云端聊天记录与附件满 {storage.retentionDays} 天自动清理并释放底层对象存储，本地 IndexedDB 缓存不受影响；表情包与头像永久保留。
              </p>
            </div>
            <button type="button" class="adm-btn is-primary" disabled={cleaning} onClick={onCleanup}>
              <Icon name="trash" size={16} />
              <span>{cleaning ? '执行中…' : '立即清理过期数据 & GC'}</span>
            </button>
          </div>

          <div class="adm-kpi-grid is-four">
            <div class="adm-kpi-card is-static">
              <div class="adm-kpi-top">
                <span>总媒体存储</span>
              </div>
              <strong class="adm-kpi-value">{formatBytes(totalBytes)}</strong>
              <div class="adm-kpi-sub">
                <span>
                  共 {formatNumber(storage.files.total + storage.stickers.total + storage.avatars.total)} 项对象
                </span>
              </div>
            </div>
            <div class="adm-kpi-card is-static">
              <div class="adm-kpi-top">
                <span>7 天临时附件</span>
              </div>
              <strong class="adm-kpi-value">{formatBytes(storage.files.bytes)}</strong>
              <div class="adm-kpi-sub">
                <span>{storage.files.total} 个</span>
                <span>
                  待过期 {storage.files.expiredPending} · 孤儿 {storage.files.orphanPending}
                </span>
              </div>
            </div>
            <div class="adm-kpi-card is-static">
              <div class="adm-kpi-top">
                <span>永久表情包</span>
              </div>
              <strong class="adm-kpi-value">{formatBytes(storage.stickers.bytes)}</strong>
              <div class="adm-kpi-sub">
                <span>{storage.stickers.total} 个收藏</span>
                <em class="adm-delta">永久保留</em>
              </div>
            </div>
            <div class="adm-kpi-card is-static">
              <div class="adm-kpi-top">
                <span>永久头像 & 待 GC</span>
              </div>
              <strong class="adm-kpi-value">{formatBytes(storage.avatars.bytes)}</strong>
              <div class="adm-kpi-sub">
                <span>{storage.avatars.total} 个头像</span>
                <span>
                  GC 队列 {storage.gcQueue.length} · 悬空 {storage.orphanMediaCount}
                </span>
              </div>
            </div>
          </div>

          <div class="adm-storage-bar">
            <span class="seg-files" style={{ width: `${filePct}%` }} />
            <span class="seg-stickers" style={{ width: `${stickerPct}%` }} />
            <span class="seg-avatars" style={{ width: `${avatarPct}%` }} />
          </div>
        </div>

        <div class="adm-two-col">
          <section class="adm-card">
            <div class="adm-card-head">
              <h2>账号存储占用排行（Top 20）</h2>
            </div>
            <div class="adm-table-scroll">
              <table class="adm-table">
                <thead>
                  <tr>
                    <th>账号</th>
                    <th>7天附件</th>
                    <th>表情包</th>
                    <th>头像</th>
                    <th class="is-right">合计</th>
                  </tr>
                </thead>
                <tbody>
                  {storage.topConsumers.length === 0 ? (
                    <tr>
                      <td colspan={5} class="adm-table-empty">
                        当前无云端媒体占用
                      </td>
                    </tr>
                  ) : (
                    storage.topConsumers.map((c) => (
                      <tr key={c.userId}>
                        <td>
                          <div class="adm-cell-stack">
                            <strong>{c.displayName}</strong>
                            <small class="adm-muted">
                              @{c.username} · UID {c.userId}
                            </small>
                          </div>
                        </td>
                        <td>
                          {formatBytes(c.fileBytes)} <small class="adm-muted">({c.fileCount})</small>
                        </td>
                        <td>
                          {formatBytes(c.stickerBytes)} <small class="adm-muted">({c.stickerCount})</small>
                        </td>
                        <td>{formatBytes(c.avatarBytes)}</td>
                        <td class="is-right">
                          <strong>{formatBytes(c.totalBytes)}</strong>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section class="adm-card">
            <div class="adm-card-head">
              <h2>对象存储 GC 待回收队列 ({storage.gcQueue.length})</h2>
            </div>
            {storage.gcQueue.length === 0 ? (
              <p class="adm-empty">对象存储垃圾回收队列为空，无待删除底层对象。</p>
            ) : (
              <div class="adm-table-scroll">
                <table class="adm-table">
                  <thead>
                    <tr>
                      <th>Object Key</th>
                      <th class="is-right">计划回收时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {storage.gcQueue.map((item) => (
                      <tr key={item.key}>
                        <td>
                          <code class="adm-mono">{item.key}</code>
                        </td>
                        <td class="is-right">{formatDateTime(item.notBefore)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    );
  };
});
