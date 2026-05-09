// `@speakspec/next/middleware` sub-entry — middleware-only export
// so consumers' middleware.ts can import without pulling the React
// component code into the edge runtime bundle.

export { aidpBotMiddleware } from '../runtime/middleware/ai-bot-detect'
