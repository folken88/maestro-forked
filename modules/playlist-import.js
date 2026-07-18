/**
 * Folder → Playlist import
 * ------------------------------------------------------------------
 * Adds an "Import Folder" button to the Playlists sidebar (GM only).
 * Pick a music folder and every audio file in it — and, recursively, in
 * all of its subfolders — is added to a single playlist, each track given
 * a best-guess friendly name derived from its filename.
 *
 * This is a lean re-implementation of the abandoned `playlist_import`
 * module's core idea (its filename-prettifying logic is ported), without
 * the S3/progress-bar/delete-all/drag-drop machinery.
 */

import { MODULE_NAME, SETTINGS_KEYS } from "./config.js";

const AUDIO_RE = /\.(aac|flac|m4a|mid|mp3|ogg|opus|wav|webm)$/i;

/* Small words kept lowercase in Title Case (unless first/last word). */
const SMALL_WORDS = new Set(
    ["a", "an", "at", "and", "but", "by", "for", "if", "nor", "on", "of", "or", "so", "the", "to", "yet"]
);

/* --- helpers -------------------------------------------------------- */

const escHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** FilePicker implementation across versions. */
function filePickerClass() {
    return foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
}

function isAudioFile(fileName) {
    return AUDIO_RE.test(String(fileName).split("?")[0]);
}

/** Last path segment, URL-decoded, query string stripped. */
function baseName(path) {
    const clean = decodeURIComponent(String(path).split("?")[0]);
    return clean.split("/").filter(Boolean).pop() ?? clean;
}

/**
 * Best-guess a human-friendly name from a filename or folder name.
 * Strips extension + a leading track number, turns _ and - into spaces,
 * splits camelCase, then Title Cases with small-word exceptions.
 */
export function toFriendlyName(raw) {
    let name = decodeURIComponent(String(raw ?? ""));
    name = name.replace(AUDIO_RE, "");                 // drop extension
    name = name.replace(/^\s*\d+\s*[-_.)]+\s*/, "");   // "03 - ", "01.", "7) "
    name = name.replace(/[_\-]+/g, " ");               // separators → spaces
    // split camelCase / PascalCase run by run
    let prev;
    do { prev = name; name = name.replace(/([a-z0-9])([A-Z])/, "$1 $2"); } while (name !== prev);
    const words = name.replace(/\s+/g, " ").trim().split(" ");
    const titled = words.map((w, i) => {
        if (!w) return w;
        const isEdge = i === 0 || i === words.length - 1;
        if (!isEdge && SMALL_WORDS.has(w.toLowerCase())) return w.toLowerCase();
        return w[0].toUpperCase() + w.slice(1);
    });
    const result = titled.join(" ").trim();
    return result || String(raw ?? "").trim() || "Untitled";
}

/**
 * Recursively collect every audio file path under `path`.
 * Returns { files: string[], folders: number }.
 */
async function collectAudioFiles(source, path, options) {
    const FP = filePickerClass();
    const files = [];
    const seen = new Set();
    const stack = [path];
    let folders = 0;
    while (stack.length) {
        const dir = stack.pop();
        if (seen.has(dir)) continue;
        seen.add(dir);
        folders++;
        let resp;
        try {
            resp = await FP.browse(source, dir, options);
        } catch (e) {
            console.warn(`${MODULE_NAME} | playlist-import: could not browse "${dir}"`, e);
            continue;
        }
        for (const f of resp.files ?? []) if (isAudioFile(f)) files.push(f);
        for (const d of resp.dirs ?? []) if (!seen.has(d)) stack.push(d);
    }
    return { files, folders };
}

/** Open the folder picker; resolves with {path, source, bucket} or null if cancelled. */
function pickFolder() {
    return new Promise((resolve) => {
        const FP = filePickerClass();
        let done = false;
        const fp = new FP({
            type: "folder",
            title: game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.PickerTitle"),
            callback: (path, picker) => {
                done = true;
                resolve({
                    path,
                    source: picker?.activeSource ?? "data",
                    bucket: picker?.result?.bucket,
                });
            },
        });
        // Resolve null if the picker closes without a selection.
        const origClose = fp.close?.bind(fp);
        if (origClose) {
            fp.close = async (...a) => { const r = await origClose(...a); if (!done) resolve(null); return r; };
        }
        fp.render(true);
    });
}

/** Confirm dialog: choose target playlist + name. Resolves {target, pname} or null. */
async function promptImportOptions(count, folders, folderLabel, defaultName) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    const playlistOptions = game.playlists.contents
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => `<option value="${p.id}">${escHtml(p.name)}</option>`)
        .join("");
    const foundLine = game.i18n.format("MAESTRO.PLAYLIST-IMPORT.FoundFiles", {
        count, folders, folder: escHtml(folderLabel),
    });
    const content = `
      <div class="maestro-folder-import-dialog" style="padding:.25rem;">
        <p style="margin:0 0 .6rem;">${foundLine}</p>
        <div class="form-group">
          <label>${game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.Target")}</label>
          <select name="target">
            <option value="__new__" selected>${game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.NewPlaylist")}</option>
            ${playlistOptions}
          </select>
        </div>
        <div class="form-group" data-new-only>
          <label>${game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.PlaylistName")}</label>
          <input type="text" name="pname" value="${escHtml(defaultName)}" style="width:100%;"/>
        </div>
      </div>`;

    const wireToggle = (root) => {
        if (!root) return;
        const sel = root.querySelector('[name="target"]');
        const grp = root.querySelector("[data-new-only]");
        if (!sel || !grp) return;
        const upd = () => { grp.style.display = sel.value === "__new__" ? "" : "none"; };
        sel.addEventListener("change", upd);
        upd();
    };

    if (DialogV2) {
        const result = await DialogV2.wait({
            window: { title: game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.DialogTitle"), icon: "fa-solid fa-folder-plus" },
            position: { width: 460 },
            content,
            rejectClose: false,
            render: (_event, dialog) => wireToggle(dialog?.element ?? dialog),
            buttons: [
                {
                    action: "import",
                    label: game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.ImportButton"),
                    icon: "fa-solid fa-folder-plus",
                    default: true,
                    callback: (_e, _b, dialog) => {
                        const root = dialog.element;
                        return {
                            target: root.querySelector('[name="target"]')?.value ?? "__new__",
                            pname: root.querySelector('[name="pname"]')?.value ?? defaultName,
                        };
                    },
                },
                { action: "cancel", label: game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.Cancel"), icon: "fa-solid fa-xmark" },
            ],
        });
        return (result && result !== "cancel") ? result : null;
    }

    // Legacy fallback (Foundry < 13).
    return new Promise((resolve) => {
        new Dialog({
            title: game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.DialogTitle"),
            content,
            buttons: {
                import: {
                    label: game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.ImportButton"),
                    callback: (html) => {
                        const root = html[0] ?? html;
                        resolve({
                            target: root.querySelector('[name="target"]')?.value ?? "__new__",
                            pname: root.querySelector('[name="pname"]')?.value ?? defaultName,
                        });
                    },
                },
                cancel: { label: game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.Cancel"), callback: () => resolve(null) },
            },
            default: "import",
            close: () => resolve(null),
            render: (html) => wireToggle(html[0] ?? html),
        }).render(true);
    });
}

/** Create/append sounds to the target playlist. Returns count added. */
async function addSoundsToPlaylist(files, { target, pname }) {
    let playlist = target === "__new__" ? null : game.playlists.get(target);
    if (!playlist) {
        const name = (pname || "Imported").trim() || "Imported";
        playlist = await Playlist.create({ name, mode: 0 });
    }

    const usedNames = new Set(playlist.sounds.map((s) => s.name));
    const usedPaths = new Set(playlist.sounds.map((s) => s.path));
    const docs = [];
    for (const path of files) {
        if (usedPaths.has(path)) continue; // already in this playlist
        usedPaths.add(path);
        let name = toFriendlyName(baseName(path));
        if (usedNames.has(name)) {
            let i = 2;
            while (usedNames.has(`${name} (${i})`)) i++;
            name = `${name} (${i})`;
        }
        usedNames.add(name);
        docs.push({ name, path });
    }
    if (docs.length) await playlist.createEmbeddedDocuments("PlaylistSound", docs);
    return { playlist, added: docs.length, skipped: files.length - docs.length };
}

/** Full interactive flow: pick → scan → confirm → import. */
async function runFolderImport() {
    const picked = await pickFolder();
    if (!picked) return;

    const options = picked.source === "s3" && picked.bucket ? { bucket: picked.bucket } : {};
    ui.notifications?.info(game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.Scanning"));
    const { files, folders } = await collectAudioFiles(picked.source, picked.path, options);

    if (!files.length) {
        ui.notifications?.warn(game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.NoFiles"));
        return;
    }

    const defaultName = toFriendlyName(baseName(picked.path) || "Imported Music");
    const opts = await promptImportOptions(files.length, folders, picked.path, defaultName);
    if (!opts) return;

    try {
        const { playlist, added, skipped } = await addSoundsToPlaylist(files, opts);
        ui.notifications?.info(game.i18n.format("MAESTRO.PLAYLIST-IMPORT.Done", {
            added, playlist: playlist.name, skipped,
        }));
    } catch (e) {
        console.error(`${MODULE_NAME} | playlist-import failed`, e);
        ui.notifications?.error(game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.Failed"));
    }
}

/**
 * Inject the "Import Folder" button into the Playlists sidebar footer.
 * Called from Misc._onRenderPlaylistDirectory (html is jQuery-wrapped).
 */
export function addFolderImportButton(html) {
    if (!game.user?.isGM) return;
    try {
        if (!game.settings.get(MODULE_NAME, SETTINGS_KEYS.PlaylistImport.enable)) return;
    } catch (_e) { /* setting not registered yet */ return; }

    const $html = html instanceof jQuery ? html : $(html);
    if ($html.find(".maestro-folder-import").length) return; // no duplicates

    const label = game.i18n.localize("MAESTRO.PLAYLIST-IMPORT.ButtonText");
    const $btn = $(
        `<button type="button" class="maestro-folder-import" style="flex:0 0 100%;margin-top:4px;">`
        + `<i class="fas fa-folder-plus"></i> ${label}</button>`
    );
    $btn.on("click", (ev) => { ev.preventDefault(); runFolderImport(); });

    const footer = $html.find(".directory-footer");
    if (footer.length) { footer.css("display", "flex").css("flex-wrap", "wrap"); footer.append($btn); return; }
    const actions = $html.find(".header-actions");
    if (actions.length) { actions.append($btn); return; }
    $html.append($btn);
}
