import { shallowRef } from 'vue';

import { tsxComponent } from './tsx-component';
import { useExternalSnapshot, watchRender } from './render-effects';
import type { IceEndpoint } from './network-ice';
import type { NetworkDetails } from './network-telemetry';
import { deviceSession } from './device-session';
import { Dialog } from './shell/Dialog';
import { Icon } from './Icon';
import './network-connection.css';

const subscribeNetwork = (notify: () => void) => deviceSession.onNetworkChange(notify);
const readNetwork = () => deviceSession.networkStatus;
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const candidateTypes: Record<string, string> = {
  host: '主机候选',
  srflx: 'STUN 映射',
  prflx: '对端探测',
  relay: 'TURN 中继',
};

function formatRate(bitsPerSecond: number | undefined, online: boolean) {
  if (bitsPerSecond === undefined) return online ? '正在测量' : '—';
  if (bitsPerSecond >= 1_000_000) return `${numberFormat.format(bitsPerSecond / 1_000_000)} Mbit/s`;
  if (bitsPerSecond >= 1_000) return `${numberFormat.format(bitsPerSecond / 1_000)} kbit/s`;
  return `${Math.round(bitsPerSecond)} bit/s`;
}

function endpointValue(endpoint: IceEndpoint | undefined) {
  const address = endpoint?.address;
  const port = endpoint?.port;
  const metadata = [
    endpoint?.protocol?.toUpperCase(),
    endpoint?.candidateType && candidateTypes[endpoint.candidateType],
  ]
    .filter(Boolean)
    .join(' · ');
  if (!address && !port && !metadata) return '浏览器未提供';
  const host = address && port && address.includes(':') ? `[${address}]` : address;
  return (
    <>
      {host ? <code>{port ? `${host}:${port}` : host}</code> : port ? `端口 ${port}` : '地址未提供'}
      {metadata && <small>{metadata}</small>}
    </>
  );
}

export const NetworkConnection = tsxComponent(function NetworkConnection(_props: { synchronized?: boolean }) {
  const network = useExternalSnapshot(subscribeNetwork, readNetwork);
  const open = shallowRef(false);
  const trigger = shallowRef<HTMLButtonElement | null>(null);
  const details = shallowRef<NetworkDetails>();
  const reconnecting = shallowRef(false);
  const watchDetails = watchRender();

  return ({ synchronized }) => {
    const { control, latencyMs, highLatency, directBulk } = network.value;
    watchDetails(() => {
      if (!open.value) {
        details.value = undefined;
        return;
      }
      return deviceSession.watchNetworkDetails((next) => {
        details.value = next;
      });
    }, [open.value]);

    const { rates, probes, route } = details.value ?? {};
    const hasTraffic = !!control || directBulk;
    const probeResult = probes
      ? `${numberFormat.format((100 * probes.timedOut) / probes.total)}% · 最近 ${probes.total} 次`
      : control
        ? '正在测量'
        : '—';
    const quality = !control ? 'offline' : highLatency ? 'poor' : control;
    const path = control === 'direct' ? '直连' : control === 'relay' ? '加密中转' : '未连接';
    const latency = latencyMs !== null ? `${latencyMs} 毫秒` : control ? '正在测量' : '—';
    const label = `网络连接 · ${path}${quality === 'poor' ? ' · 高延迟' : ''}${latencyMs !== null ? ` · ${latency}` : ''}`;
    return (
      <>
        <button
          ref={trigger}
          type="button"
          class="network-connection"
          aria-label={label}
          title={label}
          aria-haspopup="dialog"
          aria-expanded={open.value}
          data-quality={quality}
          onClick={() => {
            open.value = true;
          }}
        >
          <Icon name="wifi" size={18} />
        </button>
        {open.value && (
          <Dialog
            title="网络连接"
            className="network-connection-dialog"
            returnFocus={trigger.value}
            onClose={() => {
              open.value = false;
            }}
          >
            {() => (
              <>
                <dl class="network-connection-details">
                  <dt>控制连接</dt>
                  <dd>{path}</dd>
                  <dt>往返延迟</dt>
                  <dd>
                    {latency}
                    {quality === 'poor' && '（偏高）'}
                  </dd>
                  <dt>附件直连</dt>
                  <dd>{directBulk ? '可用' : '未建立'}</dd>
                  {synchronized !== undefined && (
                    <>
                      <dt>会话同步</dt>
                      <dd>{!control ? '等待连接' : synchronized ? '已同步' : '等待同步'}</dd>
                    </>
                  )}
                </dl>
                {!control && (
                  <button
                    class="secondary"
                    disabled={reconnecting.value}
                    onClick={() => {
                      reconnecting.value = true;
                      void deviceSession.connect().finally(() => { reconnecting.value = false; });
                    }}
                  >
                    {reconnecting.value ? '正在连接电脑…' : '重新连接电脑'}
                  </button>
                )}
                <dl class="network-connection-details network-connection-section">
                  <dt>上传速率</dt>
                  <dd>{formatRate(rates?.sent, hasTraffic)}</dd>
                  <dt>下载速率</dt>
                  <dd>{formatRate(rates?.received, hasTraffic)}</dd>
                  <dt title="工作台探测在 2 秒内未收到回复的占比">探测超时率</dt>
                  <dd>{probeResult}</dd>
                  <dt>传输丢包率</dt>
                  <dd>{hasTraffic ? '浏览器未提供' : '—'}</dd>
                </dl>
                {(control === 'direct' || directBulk) && (
                  <section class="network-connection-section">
                    <h3>{control === 'direct' ? '直连路径' : '附件直连路径'}</h3>
                    <dl class="network-connection-details network-connection-endpoints">
                      <dt>本地地址</dt>
                      <dd>{endpointValue(route?.local)}</dd>
                      <dt>对端地址</dt>
                      <dd>{endpointValue(route?.remote)}</dd>
                    </dl>
                  </section>
                )}
              </>
            )}
          </Dialog>
        )}
      </>
    );
  };
});
