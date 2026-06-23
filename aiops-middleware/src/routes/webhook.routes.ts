import { Router } from "express";
import { handleGrafanaWebhook } from "../controllers/webhook.controller.js";

export const webhookRouter = Router();

webhookRouter.post("/grafana", handleGrafanaWebhook);
