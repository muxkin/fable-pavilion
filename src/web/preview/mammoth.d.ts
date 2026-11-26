declare module 'mammoth/mammoth.browser.min.js' {
  interface MammothImage {
    contentType: string;
    read(encoding?: 'base64'): Promise<string>;
    readAsArrayBuffer(): Promise<ArrayBuffer>;
  }
  interface MammothOptions {
    arrayBuffer: ArrayBuffer;
    convertImage?: unknown;
  }
  interface MammothResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  const mammoth: {
    convertToHtml(input: { arrayBuffer: ArrayBuffer }, options?: { convertImage?: unknown }): Promise<MammothResult>;
    images: {
      imgElement(
        callback: (image: MammothImage) => Promise<{ src: string }>,
      ): unknown;
    };
  };
  export default mammoth;
}
