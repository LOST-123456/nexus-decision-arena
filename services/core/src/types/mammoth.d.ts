/**
 * Minimal typings for `mammoth`.
 *
 * The package ships no declarations of its own and there is no maintained
 * `@types/mammoth` in the registry, so we declare exactly the surface this build
 * uses — nothing more. Keeping it narrow is deliberate: every shape below is
 * something we actually call, so the compiler can still catch a wrong option or
 * a renamed method instead of us falling back to `any`.
 *
 * Only a default export is declared, because that is what the CommonJS package
 * actually is at runtime: a namespace object. Under `verbatimModuleSyntax` the
 * compiler would happily emit named imports for declared names, and Node would
 * then refuse them — so the trap is closed here rather than at import sites.
 */
declare module "mammoth" {
  export interface MammothMessage {
    type: string;
    message: string;
  }

  export interface MammothResult {
    /** Converted output: HTML for `convertToHtml`, plain text for `extractRawText`. */
    value: string;
    /** Non-fatal problems mammoth met along the way (unsupported styles, etc.). */
    messages: MammothMessage[];
  }

  export interface MammothInput {
    buffer: Uint8Array;
  }

  export interface Mammoth {
    convertToHtml(
      input: MammothInput,
      options?: Record<string, unknown>
    ): Promise<MammothResult>;
    extractRawText(
      input: MammothInput,
      options?: Record<string, unknown>
    ): Promise<MammothResult>;
  }

  const mammoth: Mammoth;
  export default mammoth;
}
