import { tsxComponent } from '../tsx-component';
import { Icon } from '../Icon';
import { PairScanner } from '../PairScanner';
import BrandIcon from '../theme/BrandIcon.vue';
import '../pairing.css';

export const PairingView = tsxComponent(function PairingView(_props: {
  name: string;
  hostId: string;
  code: string;
  fromPairLink: boolean;
  manualPairOpen: boolean;
  busy: boolean;
  error: string;
  onName: (value: string) => void;
  onHostId: (value: string) => void;
  onCode: (value: string) => void;
  onManualPairOpen: (open: boolean) => void;
  onScan: (host: string, code: string) => void;
  onSubmit: (event: SubmitEvent) => void | Promise<void>;
  onDownload: () => void;
}) {
  return ({
    name,
    hostId,
    code,
    fromPairLink,
    manualPairOpen,
    busy,
    error,
    onName,
    onHostId,
    onCode,
    onManualPairOpen,
    onScan,
    onSubmit,
    onDownload,
  }) => {
    const detectedPair = fromPairLink && !!hostId.trim() && !!code.trim();
    return (
      <main class="pair-wrap pair-page">
        <section class="pair-content" aria-labelledby="pair-title">
          <header>
            <div class="pair-heading">
              <BrandIcon class="pair-brand-icon" size={72} />
              <h1 id="pair-title">手动配对</h1>
            </div>
            <p class="pair-instructions">扫描电脑适配器显示的配对二维码，或手动输入配对码。</p>
          </header>
          <PairScanner onScan={onScan} />
          <form class="pair-form" onSubmit={onSubmit}>
            {detectedPair && (
              <p class="pair-detected" role="status">
                <Icon name="check" size={18} />
                已读取配对链接，点击「连接电脑」即可。
              </p>
            )}
            <label>
              设备名称
              <input
                value={name}
                onInput={(e) => onName((e.currentTarget as HTMLInputElement).value)}
                maxlength={80}
                required
                autocomplete="off"
              />
            </label>
            <details
              class="pair-manual"
              open={manualPairOpen}
              onToggle={(event) => onManualPairOpen((event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>
                <Icon name="chevron" size={18} />
                手动输入配对码
              </summary>
              <div class="pair-manual-fields">
                <label>
                  电脑身份
                  <input
                    value={hostId}
                    onInput={(e) => onHostId((e.currentTarget as HTMLInputElement).value)}
                    required={manualPairOpen}
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck={false}
                  />
                </label>
                <label>
                  一次性配对码
                  <input
                    value={code}
                    onInput={(e) => onCode((e.currentTarget as HTMLInputElement).value)}
                    required={manualPairOpen}
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck={false}
                    placeholder="粘贴电脑上生成的配对码"
                  />
                </label>
              </div>
            </details>
            {(manualPairOpen || detectedPair) && (
              <button
                class="primary pair-submit"
                disabled={busy || !hostId.trim() || !code.trim() || !name.trim()}
              >
                {busy ? '正在配对…' : '连接电脑'}
              </button>
            )}
            {error && (
              <p role="alert" class="error">
                {error}
              </p>
            )}
          </form>
          <button class="pair-download" type="button" onClick={onDownload}>
            <Icon name="download" size={22} />
            下载电脑适配器
          </button>
        </section>
      </main>
    );
  };
});
