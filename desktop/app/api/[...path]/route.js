// Every API request goes through lib/api.js — see the comment there for why one router.
import { handle } from "../../../lib/api.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const forward = async (req, ctx) => handle(req, (await ctx.params).path || []);

export { forward as GET, forward as POST, forward as PATCH, forward as DELETE, forward as OPTIONS };
