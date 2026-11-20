import { parsePairingLink } from '../shared/pairing-link';
import { QrScanner } from './QrScanner';
import { tsxComponent } from './tsx-component';

export const PairScanner = tsxComponent(function PairScanner(_props: {
  onScan: (host: string, code: string) => void;
}) {
  return ({ onScan }) => (
    <QrScanner
      className="pair-scanner"
      cameraAction="扫描配对二维码"
      cameraLabel="配对扫码相机"
      imageAction="识别二维码图片"
      imageLabel="识别配对二维码图片"
      manualLinkLabel="配对链接"
      actionIcons
      onScan={(text) => {
        const { host, code } = parsePairingLink(text, location.origin);
        onScan(host, code);
      }}
    />
  );
});
