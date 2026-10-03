import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";
import { storage } from "./storage.js";
import { authenticateToken } from "./auth.js";
import { configLoader } from "./config-loader.js";
import { routesLogger } from "./logger.js";
import {
  sensitiveEndpointLimiter,
  sanitizeGameId,
  sanitizeJournalEntryId,
  sanitizeMilestoneId,
  sanitizeScreenshotId,
  validateRequest,
} from "./middleware.js";
import {
  insertGameJournalEntrySchema,
  insertGameMilestoneSchema,
  updateGameMilestoneSchema,
  updateGameScreenshotSchema,
  type User,
} from "../shared/schema.js";

const router = Router();

/** Base directory all per-game screenshot folders live under. Exported so the
 * game-deletion flow can clean up a game's screenshots on disk. */
export const screenshotsRootDir = () => path.join(configLoader.getConfigDir(), "screenshots");

/** Per-game screenshot directory, exported for reuse by the game-deletion cleanup. */
export function screenshotDirForGame(gameId: string): string {
  // gameId is already UUID-regex-validated by sanitizeGameId, but normalize and
  // strip any leading ".." segments here too so this segment can never carry a
  // path traversal, independent of that upstream check.
  const safeGameId = path.normalize(gameId).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(screenshotsRootDir(), safeGameId);
}

const ALLOWED_SCREENSHOT_MIME_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8_000_000, // 8MB, at SonarCloud's advisory threshold for this rule
    files: 1,
    fields: 1, // only the "caption" text field is allowed alongside the file
    fieldSize: 1024,
  },
  fileFilter: (_req, file, cb) => {
    // A first-pass check on the client-declared MIME type, purely to reject
    // obviously-wrong uploads early; the authoritative check is the
    // magic-byte sniff on the buffer itself, once multer has read it.
    if (Object.hasOwn(ALLOWED_SCREENSHOT_MIME_TYPES, file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error("Only JPEG, PNG, and WebP images are allowed"));
  },
});

/**
 * Resolves `filePath` and asserts it stays within `dir` (also resolved), throwing
 * otherwise. `gameId` is already regex-validated as a UUID by `sanitizeGameId` and
 * filenames are always server-generated, so traversal isn't reachable in practice --
 * this is a defense-in-depth guard against every screenshot filesystem operation
 * being built from request-derived path segments.
 */
function resolveWithinDir(dir: string, filePath: string): string {
  const resolvedDir = path.resolve(dir);
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(resolvedDir + path.sep)) {
    throw new Error("Resolved path escapes the screenshots directory");
  }
  return resolvedPath;
}

/** Verifies the game exists and belongs to the requesting user; returns 404 otherwise. */
async function requireOwnedGame(req: Request, res: Response): Promise<string | null> {
  const { id } = req.params as { id: string };
  const user = req.user as User;
  const game = await storage.getGame(id);
  if (!game || game.userId !== user.id) {
    res.status(404).json({ error: "Game not found" });
    return null;
  }
  return id;
}

// ─── Journal entries (local-only notes) ─────────────────────────────────────

router.get(
  "/api/games/:id/journal",
  authenticateToken,
  sanitizeGameId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;
      const entries = await storage.getGameJournalEntries(gameId, user.id);
      return res.json(entries);
    } catch (error) {
      routesLogger.error({ error }, "Error fetching journal entries");
      return res.status(500).json({ error: "Failed to fetch journal entries" });
    }
  }
);

router.post(
  "/api/games/:id/journal",
  authenticateToken,
  sensitiveEndpointLimiter,
  sanitizeGameId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;
      const { note } = insertGameJournalEntrySchema.pick({ note: true }).parse(req.body);

      const entry = await storage.addGameJournalEntry({ gameId, userId: user.id, note });
      return res.status(201).json(entry);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid journal entry", details: error.issues });
      }
      routesLogger.error({ error }, "Error adding journal entry");
      return res.status(500).json({ error: "Failed to add journal entry" });
    }
  }
);

router.delete(
  "/api/games/:id/journal/:entryId",
  authenticateToken,
  sensitiveEndpointLimiter,
  sanitizeGameId,
  sanitizeJournalEntryId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;
      const { entryId } = req.params as { entryId: string };
      const deleted = await storage.deleteGameJournalEntry(entryId, gameId, user.id);
      if (!deleted) return res.status(404).json({ error: "Journal entry not found" });
      return res.status(204).send();
    } catch (error) {
      routesLogger.error({ error }, "Error deleting journal entry");
      return res.status(500).json({ error: "Failed to delete journal entry" });
    }
  }
);

// ─── Milestones (manual "successes" checklist) ──────────────────────────────

router.get(
  "/api/games/:id/milestones",
  authenticateToken,
  sanitizeGameId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;
      const milestones = await storage.getGameMilestones(gameId, user.id);
      return res.json(milestones);
    } catch (error) {
      routesLogger.error({ error }, "Error fetching milestones");
      return res.status(500).json({ error: "Failed to fetch milestones" });
    }
  }
);

router.post(
  "/api/games/:id/milestones",
  authenticateToken,
  sensitiveEndpointLimiter,
  sanitizeGameId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;
      const { label } = insertGameMilestoneSchema.pick({ label: true }).parse(req.body);

      const milestone = await storage.addGameMilestone({ gameId, userId: user.id, label });
      return res.status(201).json(milestone);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid milestone", details: error.issues });
      }
      routesLogger.error({ error }, "Error adding milestone");
      return res.status(500).json({ error: "Failed to add milestone" });
    }
  }
);

router.patch(
  "/api/games/:id/milestones/:milestoneId",
  authenticateToken,
  sensitiveEndpointLimiter,
  sanitizeGameId,
  sanitizeMilestoneId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;
      const { milestoneId } = req.params as { milestoneId: string };
      const { completed } = updateGameMilestoneSchema.parse(req.body);

      const updated = await storage.updateGameMilestone(milestoneId, gameId, user.id, completed);
      if (!updated) return res.status(404).json({ error: "Milestone not found" });
      return res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid milestone update", details: error.issues });
      }
      routesLogger.error({ error }, "Error updating milestone");
      return res.status(500).json({ error: "Failed to update milestone" });
    }
  }
);

router.delete(
  "/api/games/:id/milestones/:milestoneId",
  authenticateToken,
  sensitiveEndpointLimiter,
  sanitizeGameId,
  sanitizeMilestoneId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;
      const { milestoneId } = req.params as { milestoneId: string };
      const deleted = await storage.deleteGameMilestone(milestoneId, gameId, user.id);
      if (!deleted) return res.status(404).json({ error: "Milestone not found" });
      return res.status(204).send();
    } catch (error) {
      routesLogger.error({ error }, "Error deleting milestone");
      return res.status(500).json({ error: "Failed to delete milestone" });
    }
  }
);

// ─── Screenshots ─────────────────────────────────────────────────────────────

router.get(
  "/api/games/:id/screenshots",
  authenticateToken,
  sanitizeGameId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;
      const screenshots = await storage.getGameScreenshots(gameId, user.id);
      return res.json(
        screenshots.map((s) => ({
          ...s,
          url: `/api/games/${gameId}/screenshots/${s.id}/file`,
        }))
      );
    } catch (error) {
      routesLogger.error({ error }, "Error fetching screenshots");
      return res.status(500).json({ error: "Failed to fetch screenshots" });
    }
  }
);

router.post(
  "/api/games/:id/screenshots",
  authenticateToken,
  sensitiveEndpointLimiter,
  sanitizeGameId,
  validateRequest,
  (req: Request, res: Response, next: NextFunction) =>
    screenshotUpload.single("file")(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : "Invalid upload";
        return res.status(400).json({ error: message });
      }
      return next();
    }),
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;

      if (!req.file) {
        return res.status(400).json({ error: "A screenshot file is required" });
      }

      // Authoritative check: sniff the actual bytes rather than trusting the
      // client-controlled Content-Type / filename, so an uploaded file can't
      // masquerade as an image it isn't.
      const detected = await fileTypeFromBuffer(req.file.buffer);
      if (!detected || !Object.hasOwn(ALLOWED_SCREENSHOT_MIME_TYPES, detected.mime)) {
        return res.status(400).json({ error: "Only JPEG, PNG, and WebP images are allowed" });
      }

      const caption =
        typeof req.body.caption === "string" ? req.body.caption.trim().slice(0, 300) || null : null;

      const dir = screenshotDirForGame(gameId);
      await fs.promises.mkdir(dir, { recursive: true });

      const extension = ALLOWED_SCREENSHOT_MIME_TYPES[detected.mime];
      const fileName = `${randomUUID()}${extension}`;
      const filePath = resolveWithinDir(dir, path.join(dir, fileName));
      await fs.promises.writeFile(filePath, req.file.buffer);

      const screenshot = await storage
        .addGameScreenshot({
          gameId,
          userId: user.id,
          filePath,
          caption,
        })
        .catch(async (error: unknown) => {
          await fs.promises.unlink(filePath).catch((cleanupError: unknown) => {
            routesLogger.warn(
              { error: cleanupError, filePath },
              "Failed to delete screenshot file after metadata insert failure"
            );
          });
          throw error;
        });

      return res.status(201).json({
        ...screenshot,
        url: `/api/games/${gameId}/screenshots/${screenshot.id}/file`,
      });
    } catch (error) {
      routesLogger.error({ error }, "Error uploading screenshot");
      return res.status(500).json({ error: "Failed to upload screenshot" });
    }
  }
);

router.get(
  "/api/games/:id/screenshots/:screenshotId/file",
  authenticateToken,
  sanitizeGameId,
  sanitizeScreenshotId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;

      const screenshots = await storage.getGameScreenshots(gameId, user.id);
      const screenshot = screenshots.find((s) => s.id === req.params.screenshotId);
      if (!screenshot) return res.status(404).json({ error: "Screenshot not found" });

      const filePath = resolveWithinDir(screenshotDirForGame(gameId), screenshot.filePath);
      return res.sendFile(filePath, (error) => {
        if (error) {
          routesLogger.error({ error }, "Error sending screenshot file");
          if (!res.headersSent) res.status(404).json({ error: "Screenshot file not found" });
        }
      });
    } catch (error) {
      routesLogger.error({ error }, "Error fetching screenshot file");
      return res.status(500).json({ error: "Failed to fetch screenshot" });
    }
  }
);

router.patch(
  "/api/games/:id/screenshots/:screenshotId",
  authenticateToken,
  sensitiveEndpointLimiter,
  sanitizeGameId,
  sanitizeScreenshotId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;
      const { screenshotId } = req.params as { screenshotId: string };
      const { caption } = updateGameScreenshotSchema.parse(req.body);

      const updated = await storage.updateGameScreenshotCaption(
        screenshotId,
        gameId,
        user.id,
        caption
      );
      if (!updated) return res.status(404).json({ error: "Screenshot not found" });
      return res.json({ ...updated, url: `/api/games/${gameId}/screenshots/${updated.id}/file` });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid caption", details: error.issues });
      }
      routesLogger.error({ error }, "Error updating screenshot caption");
      return res.status(500).json({ error: "Failed to update screenshot" });
    }
  }
);

router.delete(
  "/api/games/:id/screenshots/:screenshotId",
  authenticateToken,
  sensitiveEndpointLimiter,
  sanitizeGameId,
  sanitizeScreenshotId,
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const gameId = await requireOwnedGame(req, res);
      if (!gameId) return;
      const user = req.user as User;
      const { screenshotId } = req.params as { screenshotId: string };
      const owned = await storage.getGameScreenshots(gameId, user.id);
      if (!owned.some((s) => s.id === screenshotId)) {
        return res.status(404).json({ error: "Screenshot not found" });
      }
      const deleted = await storage.deleteGameScreenshot(screenshotId, user.id);
      if (!deleted) return res.status(404).json({ error: "Screenshot not found" });

      const filePath = resolveWithinDir(screenshotDirForGame(gameId), deleted.filePath);
      await fs.promises.unlink(filePath).catch((error) => {
        routesLogger.warn({ error, filePath }, "Failed to delete screenshot file");
      });

      return res.status(204).send();
    } catch (error) {
      routesLogger.error({ error }, "Error deleting screenshot");
      return res.status(500).json({ error: "Failed to delete screenshot" });
    }
  }
);

export const gameJournalRoutes = router;
