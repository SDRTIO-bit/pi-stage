// ============================================================
// Type declarations for png-chunks-extract and png-chunk-text
// ============================================================

declare module "png-chunks-extract" {
  interface PngChunk {
    name: string
    data: Uint8Array
  }
  function extractChunks(buffer: Buffer | Uint8Array): PngChunk[]
  export default extractChunks
}

declare module "png-chunk-text" {
  interface DecodedText {
    keyword: string
    text: string
  }
  export function decode(chunk: { name: string; data: Uint8Array }): DecodedText
}
