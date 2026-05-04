import { Request, Response, NextFunction } from "express";
import { getBetterAuthSession } from "../lib/betterAuth";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = await getBetterAuthSession(req);
    if (!session?.user) {
      res.status(401).json({ detail: "Missing or invalid auth session" });
      return;
    }

    res.locals.userId = session.user.id;
    res.locals.userEmail = session.user.email?.toLowerCase() ?? "";
    next();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ detail });
  }
}
