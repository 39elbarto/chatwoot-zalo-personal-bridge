declare module "qrcode-terminal" {
  const qrcode: {
    generate: (text: string, options?: { small?: boolean }, cb?: (qrcode: string) => void) => void;
  };
  export default qrcode;
}
