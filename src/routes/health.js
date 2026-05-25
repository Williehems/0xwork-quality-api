import { Router } from "express";

export const healthRoute = Router();

healthRoute.get("/", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});
