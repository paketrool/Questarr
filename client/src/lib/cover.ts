import { withBasePath } from "@/lib/app-path";

/** Shown for games without cover art (added manually or through the API). */
const PLACEHOLDER_COVER_PATH = "/placeholder-game-cover.svg";

export function coverSrc(coverUrl: string | null | undefined): string {
  return coverUrl || withBasePath(PLACEHOLDER_COVER_PATH);
}
