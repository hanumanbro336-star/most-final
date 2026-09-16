				import worker, * as OTHER_EXPORTS from "/vercel/share/v0-project/worker/src/index.ts";
				import * as __MIDDLEWARE_0__ from "/vercel/share/v0-project/node_modules/.pnpm/wrangler@4.131.2_@cloudflare+workers-types@5.20260915.1_@types+node@24.10.4/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts";
import * as __MIDDLEWARE_1__ from "/vercel/share/v0-project/node_modules/.pnpm/wrangler@4.131.2_@cloudflare+workers-types@5.20260915.1_@types+node@24.10.4/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts";

				export * from "/vercel/share/v0-project/worker/src/index.ts";
				const MIDDLEWARE_TEST_INJECT = "__INJECT_FOR_TESTING_WRANGLER_MIDDLEWARE__";
				export const __INTERNAL_WRANGLER_MIDDLEWARE__ = [
					
					__MIDDLEWARE_0__.default,__MIDDLEWARE_1__.default
				]
				export default worker;