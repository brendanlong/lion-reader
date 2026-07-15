/**
 * Admin Status Content
 *
 * Controls the site-wide announcement banner and maintenance mode. Both flags
 * are stored in Redis (DB-independent) so maintenance mode works during a
 * database migration. See src/server/services/site-status.ts.
 */

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, StatusCard } from "@/components/ui/card";
import { SpinnerIcon } from "@/components/ui/icon-button";
import { AnnouncementBannerView } from "@/components/layout/AnnouncementBanner";
import type { AnnouncementLevel } from "@/server/services/site-status";

const MESSAGE_MAX = 1000;

const textareaClass =
  "ui-text-sm bg-surface text-body border-edge-input focus:border-focus focus:ring-focus block w-full rounded-md border px-3 py-2 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";
const selectClass =
  "ui-text-sm bg-surface text-body border-edge-input focus:border-focus focus:ring-focus block rounded-md border px-3 py-2 focus:ring-2 focus:ring-offset-2 focus:outline-none";
const checkboxClass =
  "text-accent focus:ring-focus border-edge-input h-4 w-4 rounded dark:bg-zinc-800";

interface SiteStatus {
  maintenance: { enabled: boolean; message: string };
  announcement: { enabled: boolean; message: string; level: AnnouncementLevel };
}

/**
 * The form, seeded once from the initial query result. Split out so the seeding
 * happens via useState initializers (not a setState-in-effect). After a save the
 * query re-invalidates, but the operator's typed values are the source of truth,
 * so we deliberately don't re-seed.
 */
function StatusForm({ initial }: { initial: SiteStatus }) {
  const utils = trpc.useUtils();

  const [annEnabled, setAnnEnabled] = useState(initial.announcement.enabled);
  const [annMessage, setAnnMessage] = useState(initial.announcement.message);
  const [annLevel, setAnnLevel] = useState<AnnouncementLevel>(initial.announcement.level);

  const [maintEnabled, setMaintEnabled] = useState(initial.maintenance.enabled);
  const [maintMessage, setMaintMessage] = useState(initial.maintenance.message);

  const setAnnouncement = trpc.admin.setAnnouncement.useMutation({
    onSuccess: () => {
      void utils.admin.getSiteStatus.invalidate();
      toast.success("Announcement saved");
    },
    onError: (error) => toast.error(error.message || "Failed to save announcement"),
  });

  const setMaintenance = trpc.admin.setMaintenance.useMutation({
    onSuccess: (_data, variables) => {
      setMaintEnabled(variables.enabled);
      void utils.admin.getSiteStatus.invalidate();
      toast.success(variables.enabled ? "Maintenance mode enabled" : "Maintenance mode disabled");
    },
    onError: (error) => toast.error(error.message || "Failed to update maintenance mode"),
  });

  return (
    <div className="space-y-6">
      {/* Announcement banner ------------------------------------------------ */}
      <section>
        <h2 className="ui-text-base text-body mb-1 font-semibold">Announcement banner</h2>
        <p className="text-muted ui-text-sm mb-3">
          Shown at the top of every page (including the demo and logged-out visitors). Users can
          dismiss it; changing the message re-shows it to everyone.
        </p>
        <Card>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="ann-message"
                className="ui-text-sm text-body mb-1.5 block font-medium"
              >
                Message
              </label>
              <textarea
                id="ann-message"
                rows={3}
                maxLength={MESSAGE_MAX}
                placeholder="e.g. Known issue: feed refresh is delayed. We're on it."
                value={annMessage}
                onChange={(e) => setAnnMessage(e.target.value)}
                disabled={setAnnouncement.isPending}
                className={textareaClass}
              />
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <div>
                <label
                  htmlFor="ann-level"
                  className="ui-text-sm text-body mb-1.5 block font-medium"
                >
                  Level
                </label>
                <select
                  id="ann-level"
                  value={annLevel}
                  onChange={(e) => setAnnLevel(e.target.value as AnnouncementLevel)}
                  disabled={setAnnouncement.isPending}
                  className={selectClass}
                >
                  <option value="info">Info (blue)</option>
                  <option value="warning">Warning (amber)</option>
                </select>
              </div>

              <label className="ui-text-sm text-body mt-6 flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={annEnabled}
                  onChange={(e) => setAnnEnabled(e.target.checked)}
                  disabled={setAnnouncement.isPending}
                  className={checkboxClass}
                />
                Enabled
              </label>
            </div>

            {/* Live preview */}
            {annMessage.trim() !== "" && (
              <div>
                <p className="text-muted ui-text-xs mb-1.5 font-medium">Preview</p>
                <div className="border-edge overflow-hidden rounded-md border">
                  <AnnouncementBannerView message={annMessage} level={annLevel} />
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={() =>
                  setAnnouncement.mutate({
                    enabled: annEnabled,
                    message: annMessage,
                    level: annLevel,
                  })
                }
                loading={setAnnouncement.isPending}
              >
                Save announcement
              </Button>
              <Button
                variant="secondary"
                disabled={setAnnouncement.isPending}
                onClick={() => {
                  setAnnEnabled(false);
                  setAnnMessage("");
                  setAnnLevel("info");
                  setAnnouncement.mutate({ enabled: false, message: "", level: "info" });
                }}
              >
                Clear
              </Button>
            </div>
          </div>
        </Card>
      </section>

      {/* Maintenance mode --------------------------------------------------- */}
      <section>
        <h2 className="ui-text-base text-body mb-1 font-semibold">Maintenance mode</h2>
        <p className="text-muted ui-text-sm mb-3">
          Takes the whole site and API down behind a maintenance page, and pauses the worker and
          Discord bot. The demo and this admin panel stay up. Use this for database migrations.
        </p>
        <Card>
          <div className="space-y-4">
            <StatusCard variant={maintEnabled ? "error" : "warning"}>
              {maintEnabled ? (
                <span>
                  <strong>Maintenance mode is ON.</strong> The site and API are down for everyone
                  except the demo and admin panel.
                </span>
              ) : (
                <span>
                  Enabling this makes the site and API return a maintenance page for all users
                  (except the demo and admin), and pauses the worker and Discord bot.
                </span>
              )}
            </StatusCard>

            <div>
              <label
                htmlFor="maint-message"
                className="ui-text-sm text-body mb-1.5 block font-medium"
              >
                Maintenance message <span className="text-faint font-normal">(optional)</span>
              </label>
              <textarea
                id="maint-message"
                rows={2}
                maxLength={MESSAGE_MAX}
                placeholder="Lion Reader is temporarily down for scheduled maintenance. We'll be back shortly."
                value={maintMessage}
                onChange={(e) => setMaintMessage(e.target.value)}
                disabled={setMaintenance.isPending}
                className={textareaClass}
              />
            </div>

            <div className="flex gap-2">
              {maintEnabled ? (
                <Button
                  variant="secondary"
                  loading={setMaintenance.isPending}
                  onClick={() => setMaintenance.mutate({ enabled: false, message: maintMessage })}
                >
                  Disable maintenance mode
                </Button>
              ) : (
                <Button
                  variant="danger"
                  loading={setMaintenance.isPending}
                  onClick={() => setMaintenance.mutate({ enabled: true, message: maintMessage })}
                >
                  Enable maintenance mode
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={setMaintenance.isPending}
                onClick={() =>
                  setMaintenance.mutate({ enabled: maintEnabled, message: maintMessage })
                }
              >
                Save message
              </Button>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}

export default function AdminStatusContent() {
  const statusQuery = trpc.admin.getSiteStatus.useQuery();

  if (statusQuery.isLoading || !statusQuery.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <SpinnerIcon className="text-faint h-6 w-6" />
      </div>
    );
  }

  return <StatusForm initial={statusQuery.data} />;
}
