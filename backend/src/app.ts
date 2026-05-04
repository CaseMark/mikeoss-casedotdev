import "dotenv/config";
import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { userRouter } from "./routes/user";
import { downloadsRouter } from "./routes/downloads";
import { caseWebhooksRouter } from "./routes/caseWebhooks";
import { getBetterAuthNodeHandler } from "./lib/betterAuth";

export function createApp() {
  const app = express();
  const corsOrigins = [
    process.env.FRONTEND_URL ?? "http://localhost:3000",
    ...(process.env.MIKE_DEMO_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ];

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Origin is not allowed by Mike CORS policy."));
      },
      credentials: true,
    }),
  );

  app.all("/api/auth/*", async (req, res) => {
    const handler = await getBetterAuthNodeHandler();
    return handler(req, res);
  });

  app.use(express.json({ limit: "50mb" }));

  app.use("/chat", chatRouter);
  app.use("/projects", projectsRouter);
  app.use("/matters", projectsRouter);
  app.use("/projects/:projectId/chat", projectChatRouter);
  app.use("/matters/:projectId/chat", projectChatRouter);
  app.use("/single-documents", documentsRouter);
  app.use("/tabular-review", tabularRouter);
  app.use("/workflows", workflowsRouter);
  app.use("/user", userRouter);
  app.use("/users", userRouter);
  app.use("/download", downloadsRouter);
  app.use("/webhooks/case", caseWebhooksRouter);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  return app;
}

export const app = createApp();
export default app;
