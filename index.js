const express = require("express");
const { addonBuilder } = require("stremio-addon-sdk");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function cleanEnvValue(value) {
    return (value || "").trim().replace(/^["']|["']$/g, "");
}

const app = express();
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    next();
});

const TMDB_API_KEY = cleanEnvValue(process.env.TMDB_API_KEY);
const TMDB_READ_ACCESS_TOKEN = cleanEnvValue(process.env.TMDB_READ_ACCESS_TOKEN).replace(/^Bearer\s+/i, "");
const TRAKT_CLIENT_ID = cleanEnvValue(process.env.TRAKT_CLIENT_ID);
const TRAKT_ACCESS_TOKEN = cleanEnvValue(process.env.TRAKT_ACCESS_TOKEN).replace(/^Bearer\s+/i, "");
const ADDON_URL = cleanEnvValue(process.env.ADDON_URL);
const IMAGE_VERSION = "20260722-tag-color";

const imageCache = new Map();
const tmdbCache = new Map();
const traktCache = new Map();
const tvmazeCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TMDB_CACHE_TTL_MS = 10 * 60 * 1000;
const TRAKT_CACHE_TTL_MS = 10 * 60 * 1000;
const TVMAZE_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_DIR = path.join(__dirname, "image-cache");
const IMAGE_FETCH_TIMEOUT_MS = 12000;

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheFilePath(cacheKey) {
    const hash = crypto.createHash("sha256").update(cacheKey).digest("hex");
    return path.join(CACHE_DIR, `${hash}.png`);
}

function requestBaseUrl(req) {
    const protocol = req.get("x-forwarded-proto") || req.protocol || "https";
    return `${protocol.split(",")[0]}://${req.get("host")}`;
}

async function fetchTmdbJson(url, options = {}) {
    const useBearer = options.useBearer === true && !!TMDB_READ_ACCESS_TOKEN;
    const cacheKey = `${url}|tmdbBearer:${useBearer ? "yes" : "no"}`;
    const cached = tmdbCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
        return cached.data;
    }

    const headers = { "Accept": "application/json" };
    if (useBearer) headers.Authorization = `Bearer ${TMDB_READ_ACCESS_TOKEN}`;

    const res = await fetch(url, { headers });
    if (!res.ok) {
        const error = new Error(`TMDB fetch failed: ${res.status} ${res.statusText}`);
        error.status = res.status;
        throw error;
    }
    const data = await res.json();
    tmdbCache.set(cacheKey, { data, expires: Date.now() + TMDB_CACHE_TTL_MS });
    if (tmdbCache.size > 1000) {
        const oldestKey = tmdbCache.keys().next().value;
        tmdbCache.delete(oldestKey);
    }
    return data;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchImageBuffer(url, options = {}) {
    const retries = options.retries ?? 2;
    const timeoutMs = options.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error(`Image fetch failed: ${res.status} ${res.statusText}`);
            return Buffer.from(await res.arrayBuffer());
        } catch (error) {
            lastError = error;
            if (attempt < retries) await wait(350 * (attempt + 1));
        } finally {
            clearTimeout(timeout);
        }
    }

    throw lastError;
}

async function fetchTvmazeJson(url) {
    const cached = tvmazeCache.get(url);
    if (cached && Date.now() < cached.expires) {
        return cached.data;
    }

    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) {
        throw new Error(`TVMaze fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    tvmazeCache.set(url, { data, expires: Date.now() + TVMAZE_CACHE_TTL_MS });
    if (tvmazeCache.size > 300) {
        const oldestKey = tvmazeCache.keys().next().value;
        tvmazeCache.delete(oldestKey);
    }
    return data;
}

function formatTraktErrorBody(body) {
    return body ? ` Body: ${body.replace(/\s+/g, " ").slice(0, 160)}` : "";
}

async function fetchTraktJson(pathname, options = {}) {
    if (!TRAKT_CLIENT_ID) {
        throw new Error("TRAKT_CLIENT_ID is required for Trakt catalogs.");
    }

    const useToken = options.useToken !== false && !!TRAKT_ACCESS_TOKEN;
    const url = `https://api.trakt.tv${pathname}`;
    const cacheKey = `${url}|token:${useToken ? "yes" : "no"}`;
    const cached = traktCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
        return cached.data;
    }

    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Coming-Soon/1.0",
        "trakt-api-key": TRAKT_CLIENT_ID,
        "trakt-api-version": "2"
    };
    if (useToken) {
        headers.Authorization = `Bearer ${TRAKT_ACCESS_TOKEN}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status === 403) {
            const error = new Error(`Trakt returned 403 Forbidden for ${pathname}. Authorization sent: ${useToken ? "yes" : "no"}.${formatTraktErrorBody(body)}`);
            error.status = res.status;
            error.pathname = pathname;
            error.usedToken = useToken;
            throw error;
        }
        const error = new Error(`Trakt fetch failed for ${pathname}: ${res.status} ${res.statusText}.${formatTraktErrorBody(body)}`);
        error.status = res.status;
        error.pathname = pathname;
        error.usedToken = useToken;
        throw error;
    }
    const data = await res.json();
    traktCache.set(cacheKey, { data, expires: Date.now() + TRAKT_CACHE_TTL_MS });
    if (traktCache.size > 300) {
        const oldestKey = traktCache.keys().next().value;
        traktCache.delete(oldestKey);
    }
    return data;
}

function normalizeTraktCatalogInput(input) {
    return (input || "").trim().replace(/^@/, "");
}

function extractTmdbListId(value) {
    const match = String(value || "").match(/^(\d+)/);
    return match ? match[1] : "";
}

function parseTmdbListCatalog(input) {
    const raw = normalizeTraktCatalogInput(input);
    if (!raw) return null;

    if (/^tmdb:/i.test(raw)) {
        const id = extractTmdbListId(raw.replace(/^tmdb:/i, ""));
        return id ? { source: "tmdb", kind: "list", listId: id } : null;
    }

    if (/^tmdb\/list\//i.test(raw)) {
        const id = extractTmdbListId(raw.split("/")[2]);
        return id ? { source: "tmdb", kind: "list", listId: id } : null;
    }

    if (/^tmdb\//i.test(raw)) {
        const id = extractTmdbListId(raw.split("/")[1]);
        return id ? { source: "tmdb", kind: "list", listId: id } : null;
    }

    let parsedUrl = null;
    try {
        parsedUrl = new URL(raw);
    } catch {
        parsedUrl = null;
    }

    if (parsedUrl && /(^|\.)themoviedb\.org$/i.test(parsedUrl.hostname)) {
        const parts = parsedUrl.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
        const listIndex = parts.findIndex(part => part.toLowerCase() === "list");
        if (listIndex >= 0 && parts[listIndex + 1]) {
            const id = extractTmdbListId(parts[listIndex + 1]);
            return id ? { source: "tmdb", kind: "list", listId: id } : null;
        }
        return null;
    }

    if (/^(?:list\/)?\d+(?:[-_][A-Za-z0-9_-]+)?$/i.test(raw)) {
        const id = extractTmdbListId(raw.replace(/^list\//i, ""));
        return id ? { source: "tmdb", kind: "list", listId: id } : null;
    }

    return null;
}

function parseTraktCatalog(input) {
    const raw = normalizeTraktCatalogInput(input);
    if (!raw) return null;

    let pathname = raw;
    try {
        pathname = new URL(raw).pathname;
    } catch {
        pathname = raw.startsWith("/") ? raw : `/${raw}`;
    }

    const parts = pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
    if (parts[0] === "users" && parts[1]) {
        if (parts[2] === "lists" && parts[3]) return { kind: "list", user: parts[1], list: parts[3] };
    }
    if (parts.length === 2) return { kind: "list", user: parts[0], list: parts[1] };
    if (parts.length === 3 && parts[1] === "lists") return { kind: "list", user: parts[0], list: parts[2] };

    return null;
}

function parsePublicCatalog(input) {
    return parseTmdbListCatalog(input) || parseTraktCatalog(input);
}

async function fetchTraktListItems(catalog, type) {
    const encodedUser = encodeURIComponent(catalog.user);
    const encodedList = encodeURIComponent(catalog.list);
    const pluralType = type === "series" ? "shows" : "movies";
    const singularType = type === "series" ? "show" : "movie";
    const basePath = `/users/${encodedUser}/lists/${encodedList}/items`;
    const candidates = [
        `${basePath}/${singularType}?extended=full&limit=100`,
        `${basePath}/${pluralType}?extended=full&limit=100`,
        `${basePath}?type=${singularType}&extended=full&limit=100`,
        `${basePath}?extended=full&limit=100`
    ];

    let lastError = null;
    const errors = [];
    for (const pathname of candidates) {
        try {
            return await fetchTraktJson(pathname);
        } catch (error) {
            if ((error.status === 401 || error.status === 403) && error.usedToken) {
                try {
                    return await fetchTraktJson(pathname, { useToken: false });
                } catch (fallbackError) {
                    errors.push(fallbackError.message);
                    lastError = fallbackError;
                    continue;
                }
            }
            errors.push(error.message);
            lastError = error;
        }
    }
    throw new Error(errors.length ? `Unable to fetch Trakt list. Tried: ${errors.join(" | ")}` : lastError.message);
}

async function fetchTraktTmdbSeeds(input, type) {
    const catalog = parseTraktCatalog(input);
    if (!catalog) throw new Error("Unsupported catalog. Use a public Trakt list URL, public TMDB list URL, TMDB list ID, or username/list-slug.");

    const items = await fetchTraktListItems(catalog, type);
    const mediaKey = type === "series" ? "show" : "movie";
    const seen = new Set();

    return (Array.isArray(items) ? items : [])
        .filter(item => !item.type || item.type === mediaKey)
        .map(item => item[mediaKey] || item)
        .filter(item => item?.ids?.tmdb && !seen.has(item.ids.tmdb) && seen.add(item.ids.tmdb))
        .map(item => ({
            id: item.ids.tmdb,
            title: item.title,
            name: item.title,
            overview: item.overview || "",
            _traktId: item.ids.trakt,
            _traktYear: item.year,
            _traktSlug: item.ids.slug
        }));
}

async function fetchTmdbListPage(catalog, page) {
    if (TMDB_READ_ACCESS_TOKEN) {
        try {
            return await fetchTmdbJson(
                `https://api.themoviedb.org/4/list/${encodeURIComponent(catalog.listId)}?page=${page}`,
                { useBearer: true }
            );
        } catch (error) {
            if (!TMDB_API_KEY || ![401, 403, 404].includes(error.status)) throw error;
        }
    }

    if (!TMDB_API_KEY) {
        throw new Error("TMDB_API_KEY or TMDB_READ_ACCESS_TOKEN is required for TMDB public lists.");
    }

    return fetchTmdbJson(`https://api.themoviedb.org/3/list/${encodeURIComponent(catalog.listId)}?api_key=${TMDB_API_KEY}&page=${page}`);
}

async function fetchTmdbListItems(catalog, type) {
    const targetMediaType = type === "series" ? "tv" : "movie";
    const seen = new Set();
    const out = [];
    const maxPages = 20;
    let page = 1;
    let totalPages = 1;

    do {
        const data = await fetchTmdbListPage(catalog, page);
        const items = data.results || data.items || [];

        for (const item of Array.isArray(items) ? items : []) {
            const mediaType = item.media_type || (item.first_air_date || item.name ? "tv" : "movie");
            if (mediaType !== targetMediaType || !item.id || seen.has(item.id)) continue;
            seen.add(item.id);
            out.push({
                id: item.id,
                title: item.title || item.name,
                name: item.name || item.title,
                overview: item.overview || "",
                poster_path: item.poster_path,
                backdrop_path: item.backdrop_path,
                genre_ids: item.genre_ids || [],
                original_language: item.original_language,
                release_date: item.release_date,
                first_air_date: item.first_air_date
            });
        }

        totalPages = Math.max(1, Number(data.total_pages || 1));
        page += 1;
    } while (page <= totalPages && page <= maxPages);

    return out;
}

async function fetchCatalogTmdbSeeds(input, type) {
    const catalog = parsePublicCatalog(input);
    if (!catalog) throw new Error("Unsupported catalog. Use a public Trakt list URL, public TMDB list URL, TMDB list ID, or username/list-slug.");

    return catalog.source === "tmdb"
        ? fetchTmdbListItems(catalog, type)
        : fetchTraktTmdbSeeds(input, type);
}

async function fetchTmdbTrendingTodaySeeds(type, page = 1) {
    const tmdbType = type === "series" ? "tv" : "movie";
    const data = await fetchTmdbJson(`https://api.themoviedb.org/3/trending/${tmdbType}/day?api_key=${TMDB_API_KEY}&page=${page}`);
    return (data.results || []).map(item => ({
        id: item.id,
        title: item.title || item.name,
        name: item.name || item.title,
        overview: item.overview || "",
        poster_path: item.poster_path,
        backdrop_path: item.backdrop_path,
        genre_ids: item.genre_ids || [],
        original_language: item.original_language,
        release_date: item.release_date,
        first_air_date: item.first_air_date
    }));
}

function releaseDateOnly(value) {
    if (!value) return null;
    const datePart = String(value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
    return parseLocal(datePart);
}

function earliestReleaseDateByRegion(releaseBlocks, regions, isDigitalRelease) {
    for (const region of regions) {
        const dates = [];
        for (const block of releaseBlocks || []) {
            const blockRegion = (block.iso_3166_1 || block.country || "").toUpperCase();
            if (blockRegion !== region) continue;

            const releases = block.release_dates || [block];
            for (const release of releases) {
                if (!isDigitalRelease(release)) continue;
                const date = releaseDateOnly(release.release_date);
                if (date) dates.push(date);
            }
        }
        if (dates.length > 0) return dates.sort((a, b) => a - b)[0];
    }
    return null;
}

async function fetchTmdbMovieReleaseDates(movieId) {
    const releaseData = await fetchTmdbJson(`https://api.themoviedb.org/3/movie/${movieId}/release_dates?api_key=${TMDB_API_KEY}`);
    const releaseBlocks = releaseData.results || [];

    return {
        earliestTheatrical: earliestReleaseDateByRegion(releaseBlocks, ["US"], release => [1, 2, 3].includes(release.type))
            || earliestReleaseDateByRegion(releaseBlocks, releaseBlocks.map(block => (block.iso_3166_1 || "").toUpperCase()).filter(Boolean), release => [1, 2, 3].includes(release.type)),
        earliestDigital: earliestReleaseDateByRegion(releaseBlocks, ["US", "GB"], release => release.type === 4),
        earliestPhysical: earliestReleaseDateByRegion(releaseBlocks, ["US"], release => release.type === 5)
            || earliestReleaseDateByRegion(releaseBlocks, releaseBlocks.map(block => (block.iso_3166_1 || "").toUpperCase()).filter(Boolean), release => release.type === 5)
    };
}

async function fetchTraktDigitalReleaseDate(traktId) {
    if (!traktId) return null;
    try {
        const releases = await fetchTraktJson(`/movies/${encodeURIComponent(traktId)}/releases`);
        if (!Array.isArray(releases)) return null;
        return earliestReleaseDateByRegion(releases, ["US", "GB"], release => {
            const releaseType = release.release_type;
            return (typeof releaseType === "string" && releaseType.toLowerCase() === "digital") || releaseType === 4;
        });
    } catch {
        return null;
    }
}

async function fetchTraktTheatricalReleaseDate(traktId) {
    if (!traktId) return null;
    try {
        const releases = await fetchTraktJson(`/movies/${encodeURIComponent(traktId)}/releases`);
        if (!Array.isArray(releases)) return null;
        return earliestReleaseDateByRegion(releases, ["US", "GB"], release => {
            const releaseType = release.release_type;
            return (typeof releaseType === "string" && ["premiere", "limited", "theatrical"].includes(releaseType.toLowerCase()))
                || [1, 2, 3].includes(releaseType);
        });
    } catch {
        return null;
    }
}

async function fetchMovieReleaseDates(movie) {
    const fallbackDates = { earliestTheatrical: null, earliestDigital: null, earliestPhysical: null };
    try {
        const dates = await fetchTmdbMovieReleaseDates(movie.id);
        if (dates.earliestDigital && dates.earliestTheatrical) return dates;
        return {
            ...dates,
            earliestTheatrical: dates.earliestTheatrical || await fetchTraktTheatricalReleaseDate(movie._traktId),
            earliestDigital: dates.earliestDigital || await fetchTraktDigitalReleaseDate(movie._traktId)
        };
    } catch {
        return {
            ...fallbackDates,
            earliestTheatrical: await fetchTraktTheatricalReleaseDate(movie._traktId),
            earliestDigital: await fetchTraktDigitalReleaseDate(movie._traktId)
        };
    }
}

function dateOnlyInTimeZone(value, timeZone = "America/New_York") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);
    const dateParts = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return parseLocal(`${dateParts.year}-${dateParts.month}-${dateParts.day}`);
}

function normalizeEpisodeDate(value) {
    if (!value) return null;
    const dateValue = String(value);
    const datePart = dateValue.includes("T") ? dateValue.split("T")[0] : dateValue;
    return releaseDateOnly(datePart);
}

function sourceDateOnlyEpisodeDate(value) {
    if (!value) return null;
    const dateValue = String(value);
    const datePart = dateValue.includes("T") ? dateValue.split("T")[0] : dateValue;
    return releaseDateOnly(datePart);
}

function episodeSourcePriority(episode) {
    if (!episode) return 0;
    if (episode.source === "tvmaze") return 3;
    if (episode.source === "tmdb") return 2;
    if (episode.source === "trakt") return 1;
    return 0;
}

function tmdbEpisodeFields(episode) {
    if (!episode) return null;
    return {
        air_date: episode.air_date,
        season_number: episode.season_number,
        episode_number: episode.episode_number,
        episode_type: episode.episode_type,
        source: "tmdb"
    };
}

function tvmazeEpisodeFields(episode) {
    if (!episode) return null;
    return {
        air_date: episode.airdate,
        season_number: episode.season,
        episode_number: episode.number,
        episode_type: episode.type === "finale" ? "finale" : null,
        source: "tvmaze"
    };
}

function traktEpisodeFields(episode) {
    if (!episode) return null;
    return {
        air_date: episode.first_aired ? String(episode.first_aired).split("T")[0] : null,
        season_number: episode.season,
        episode_number: episode.number,
        episode_type: episode.episode_type || null,
        source: "trakt"
    };
}

function deriveEpisodeTimeline(episodes, today) {
    const datedEpisodes = (episodes || [])
        .map(episode => ({ ...episode, _airDate: normalizeEpisodeDate(episode.air_date) }))
        .filter(episode => episode._airDate)
        .sort((a, b) => a._airDate - b._airDate || (a.season_number || 0) - (b.season_number || 0) || (a.episode_number || 0) - (b.episode_number || 0));

    if (datedEpisodes.length === 0) return null;

    const airedEpisodes = datedEpisodes.filter(episode => episode._airDate <= today);
    const futureEpisodes = datedEpisodes.filter(episode => episode._airDate > today);
    const firstAiredEpisode = datedEpisodes.find(episode => (episode.season_number || 0) > 0);
    const latestAiredSeasonNumber = Math.max(0, ...airedEpisodes.map(episode => episode.season_number || 0));
    const latestSeasonPremiere = latestAiredSeasonNumber > 0
        ? airedEpisodes.find(episode => episode.season_number === latestAiredSeasonNumber && episode.episode_number === 1)
            || airedEpisodes.find(episode => episode.season_number === latestAiredSeasonNumber)
        : null;

    return {
        lastEp: airedEpisodes[airedEpisodes.length - 1] || null,
        nextEp: futureEpisodes[0] || null,
        firstAir: firstAiredEpisode?._airDate || null,
        seasonAir: latestSeasonPremiere?._airDate || null,
        source: "episodes"
    };
}

function episodeKey(episode) {
    if (!episode) return null;
    const season = episode.season_number;
    const number = episode.episode_number;
    return season != null && number != null ? `${season}:${number}` : null;
}

function earliestDate(...dates) {
    return dates
        .filter(Boolean)
        .sort((a, b) => a - b)[0] || null;
}

function mergeEpisodeTimelines(timelines, today) {
    const validTimelines = timelines.filter(Boolean);
    const episodeMap = new Map();

    validTimelines
        .flatMap(timeline => timeline.episodes || [timeline.lastEp, timeline.nextEp])
        .filter(Boolean)
        .forEach(episode => {
            const date = sourceDateOnlyEpisodeDate(episode.air_date);
            if (!date) return;
            const key = episodeKey(episode) || `${episode.air_date}:${episode.name || ""}`;
            const current = episodeMap.get(key);
            const currentDate = current ? sourceDateOnlyEpisodeDate(current.air_date) : null;
            const priority = episodeSourcePriority(episode);
            const currentPriority = episodeSourcePriority(current);
            if (!current || priority > currentPriority || (priority === currentPriority && date < currentDate)) {
                episodeMap.set(key, episode);
            }
        });

    const mergedTimeline = deriveEpisodeTimeline([...episodeMap.values()], today);
    if (!mergedTimeline) return validTimelines[0] || null;

    return {
        ...mergedTimeline,
        firstAir: earliestDate(...validTimelines.map(timeline => timeline.firstAir), mergedTimeline.firstAir),
        seasonAir: earliestDate(...validTimelines.map(timeline => timeline.seasonAir), mergedTimeline.seasonAir),
        source: validTimelines.map(timeline => timeline.source).join("+")
    };
}

async function fetchTvmazeEpisodeTimeline(tvData, today) {
    const externalIds = tvData.external_ids || {};
    let lookupUrl = null;
    if (externalIds.tvdb_id) {
        lookupUrl = `https://api.tvmaze.com/lookup/shows?thetvdb=${encodeURIComponent(externalIds.tvdb_id)}`;
    } else if (externalIds.imdb_id) {
        lookupUrl = `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(externalIds.imdb_id)}`;
    }
    if (!lookupUrl) return null;

    try {
        const show = await fetchTvmazeJson(lookupUrl);
        if (!show?.id) return null;
        const episodes = await fetchTvmazeJson(`https://api.tvmaze.com/shows/${encodeURIComponent(show.id)}/episodes`);
        const episodeFields = Array.isArray(episodes) ? episodes.map(tvmazeEpisodeFields).filter(Boolean) : [];
        const timeline = deriveEpisodeTimeline(episodeFields, today);
        return timeline ? { ...timeline, episodes: episodeFields, source: "tvmaze" } : null;
    } catch {
        return null;
    }
}

function tmdbEpisodeTimeline(tvData, today) {
    const episodeFields = [
        tmdbEpisodeFields(tvData.last_episode_to_air),
        tmdbEpisodeFields(tvData.next_episode_to_air)
    ].filter(Boolean);
    const timeline = deriveEpisodeTimeline(episodeFields, today);

    return {
        lastEp: timeline?.lastEp || tmdbEpisodeFields(tvData.last_episode_to_air),
        nextEp: timeline?.nextEp || tmdbEpisodeFields(tvData.next_episode_to_air),
        firstAir: normalizeEpisodeDate(tvData.first_air_date),
        seasonAir: null,
        episodes: episodeFields,
        source: "tmdb"
    };
}

async function fetchTraktEpisodeTimeline(traktId, today) {
    if (!traktId) return null;
    try {
        const start = new Date(today);
        start.setDate(start.getDate() - 30);
        const days = 75;
        const yyyy = start.getFullYear();
        const mm = String(start.getMonth() + 1).padStart(2, "0");
        const dd = String(start.getDate()).padStart(2, "0");
        const calendar = await fetchTraktJson(`/calendars/all/shows/${yyyy}-${mm}-${dd}/${days}?extended=full`);
        const episodes = (Array.isArray(calendar) ? calendar : [])
            .filter(item => Number(item.show?.ids?.trakt) === Number(traktId))
            .map(item => traktEpisodeFields(item.episode))
            .filter(Boolean);
        const timeline = deriveEpisodeTimeline(episodes, today);
        return timeline ? { ...timeline, episodes, source: "trakt" } : null;
    } catch {
        return null;
    }
}

async function fetchSeriesEpisodeTimeline(tvData, traktId, today) {
    const tvmazeTimeline = await fetchTvmazeEpisodeTimeline(tvData, today);
    const tmdbTimeline = tmdbEpisodeTimeline(tvData, today);
    const traktTimeline = await fetchTraktEpisodeTimeline(traktId, today);

    return mergeEpisodeTimelines([tvmazeTimeline, tmdbTimeline, traktTimeline], today);
}

let genreMap = {};
async function fetchGenres() {
    try {
        const [movieRes, tvRes] = await Promise.all([
            fetchTmdbJson(`https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}`),
            fetchTmdbJson(`https://api.themoviedb.org/3/genre/tv/list?api_key=${TMDB_API_KEY}`)
        ]);
        if (movieRes.genres) movieRes.genres.forEach(g => genreMap[g.id] = g.name);
        if (tvRes.genres) tvRes.genres.forEach(g => genreMap[g.id] = g.name);
        console.log("Genres loaded successfully!");
    } catch (error) { console.error("Failed to fetch genres:", error); }
}
fetchGenres();

const DEFAULT_CATALOGS = {
    movies: "Coming Soon Movies",
    shows: "Coming Soon Shows",
    theaters: "In Theaters"
};

function displayNameConfigValue(value, fallback) {
    const cleaned = cleanEnvValue(value);
    return cleaned || fallback;
}

function configuredCatalogs(config = {}) {
    return [
        { id: "calendar_lite_movies", type: "movie", name: displayNameConfigValue(config.moviesDisplayName, DEFAULT_CATALOGS.movies) },
        { id: "calendar_lite_shows", type: "series", name: displayNameConfigValue(config.showsDisplayName, DEFAULT_CATALOGS.shows) },
        { id: "calendar_lite_theaters", type: "movie", name: displayNameConfigValue(config.theatersDisplayName, DEFAULT_CATALOGS.theaters) }
    ];
}

const manifest = {
    id: "com.pserver.calendar-lite",
    version: "1.12.3",
    name: "Coming Soon",
    description: "Customizable Stremio catalogs for upcoming and recently released content with optional graphic tags and public Trakt or TMDB lists.",
    behaviorHints: { configurable: true, configurationRequired: true },
    resources: ["catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tmdb:"],
    catalogs: configuredCatalogs()
};

const builder = new addonBuilder(manifest);

// ─── Date helpers ────────────────────────────────────────────────────────────

const parseLocal = (dateStr) => {
    if (!dateStr) return null;
    if (dateStr.length === 10) return new Date(dateStr + "T00:00:00");
    return new Date(dateStr);
};

const diffDays = (date1, date2) => {
    const d1 = new Date(date1); d1.setHours(0, 0, 0, 0);
    const d2 = new Date(date2); d2.setHours(0, 0, 0, 0);
    return Math.round(Math.abs(d1 - d2) / (1000 * 60 * 60 * 24));
};

const formatFutureDate = (dateObj) => {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${monthNames[dateObj.getMonth()]} ${dateObj.getDate()}`;
};

const tagDisplayNameMap = {
    "new_release": "New Release",
    "new_movie": "New Movie",
    "in_theaters": "In Theaters",
    "coming_soon": "Coming Soon",
    "new_series": "New Series",
    "season_finale": "Season Finale",
    "series_finale": "Series Finale",
    "final_season": "Final Season",
    "new_season": "New Season",
    "new_episode": "New Episode"
};

// ─── Shared image-generation helpers ─────────────────────────────────────────

/**
 * Resolve a tag string to its display text, or null if none.
 */
function parseTagText(tag) {
    if (!tag || tag === 'none') return null;
    if (tagDisplayNameMap[tag]) return tagDisplayNameMap[tag];
    if (tag.startsWith('coming_date_')) {
        const [month, day] = tag.replace('coming_date_', '').split('_');
        return `Coming ${month} ${day}`;
    }
    if (tag.startsWith('coming_soon_date_')) {
        const [month, day] = tag.replace('coming_soon_date_', '').split('_');
        return `Coming Soon ${month} ${day}`;
    }
    if (tag.startsWith('finale_date_')) {
        const [month, day] = tag.replace('finale_date_', '').split('_');
        return `Finale ${month} ${day}`;
    }
    if (tag.startsWith('next_episode_date_')) {
        const [month, day] = tag.replace('next_episode_date_', '').split('_');
        return `Next Episode ${month} ${day}`;
    }
    return null;
}

/**
 * Determine the best provider/network logo to show.
 * Returns { path, isNetwork } or null.
 */
function resolveProviderLogoInfo(tmdbType, details) {
    const cleanString = (str) => str ? str.toLowerCase().replace(/\+/g, 'plus').replace(/\s+/g, '') : '';
    const customMappings = {
        "hbo": "max", "cbs": "paramount", "nbc": "peacock",
        "fx": "hulu", "abc": "hulu", "fox": "hulu",
        "amc": "amc", "showtime": "paramount", "the cw": "max", "bbc": "britbox"
    };
    const topTiers = ['netflix', 'max', 'disney', 'hulu', 'apple', 'paramount', 'peacock',
        'crunchyroll', 'mgm', 'starz', 'showtime', 'amc', 'amazon'];

    let usProviders = null;
    if (details['watch/providers']?.results) {
        const providers = details['watch/providers'].results;
        usProviders = providers.US;
    }

    // Pre-filter flatrate providers to exclude channel/store-within-a-store versions
    const validFlatrate = (usProviders?.flatrate || []).filter(p => {
        const pName = cleanString(p.provider_name);
        return !((pName.includes('amazon') && pName.includes('channel')) ||
            (pName.includes('roku') && pName.includes('premium')) ||
            (pName.includes('apple') && pName.includes('channel')));
    });

    // 1. Match TV network → streaming provider
    if (tmdbType === 'tv' && details.networks?.length > 0) {
        const networkName = details.networks[0].name;
        const targetProvider = customMappings[networkName.toLowerCase()] || cleanString(networkName);
        if (validFlatrate.length > 0) {
            const matched = validFlatrate.find(p => {
                const pName = cleanString(p.provider_name);
                return pName.includes(targetProvider) || targetProvider.includes(pName);
            });
            if (matched) return { path: matched.logo_path, isNetwork: false, provider: cleanString(matched.provider_name) };
        }
    }

    // 2. Pick best flatrate streaming provider
    if (validFlatrate.length > 0) {
        let best = null, bestIdx = Infinity;
        for (const p of validFlatrate) {
            const idx = topTiers.findIndex(t => cleanString(p.provider_name).includes(t));
            if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = p; }
        }
        if (!best) {
            best = validFlatrate.find(p => !cleanString(p.provider_name).includes('amazon')) || validFlatrate[0];
        }
        return { path: best.logo_path, isNetwork: false, provider: cleanString(best.provider_name) };
    }

    // 3. Fallback: raw network logo
    if (tmdbType === 'tv' && details.networks?.length > 0) {
        return { path: details.networks[0].logo_path, isNetwork: true, provider: cleanString(details.networks[0].name) };
    }

    return null;
}

function logoPlacement(baseWidth, baseTop, baseRightPad, provider) {
    const cleanedProvider = provider || "";
    if (cleanedProvider.includes("peacock")) {
        return {
            width: Math.round(baseWidth * 0.88),
            top: baseTop,
            rightPad: Math.round(baseRightPad * 2.25)
        };
    }
    return {
        width: baseWidth,
        top: baseTop,
        rightPad: baseRightPad
    };
}

/**
 * Sample the average color of the bottom half of an image.
 * Uses raw pixel data — avoids a full PNG encode/decode cycle.
 * Returns { meanR, meanG, meanB, luminance }.
 */
async function sampleBottomHalf(imageBuffer, metadata) {
    try {
        const top = Math.floor(metadata.height / 2);
        const height = metadata.height - top;

        const { data, info } = await sharp(imageBuffer)
            .extract({ left: 0, top, width: metadata.width, height })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const channels = info.channels; // 3 (RGB) or 4 (RGBA)
        const pixelCount = info.width * info.height;
        let sumR = 0, sumG = 0, sumB = 0;

        for (let i = 0; i < data.length; i += channels) {
            sumR += data[i];
            sumG += data[i + 1];
            sumB += data[i + 2];
        }

        const meanR = Math.round(sumR / pixelCount);
        const meanG = Math.round(sumG / pixelCount);
        const meanB = Math.round(sumB / pixelCount);
        const luminance = (0.299 * meanR) + (0.587 * meanG) + (0.114 * meanB);
        return { meanR, meanG, meanB, luminance };
    } catch {
        return { meanR: 26, meanG: 26, meanB: 26, luminance: 26 };
    }
}

function clampColor(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function blendColor(color, target, amount) {
    return {
        meanR: clampColor(color.meanR + (target.meanR - color.meanR) * amount),
        meanG: clampColor(color.meanG + (target.meanG - color.meanG) * amount),
        meanB: clampColor(color.meanB + (target.meanB - color.meanB) * amount)
    };
}

function colorLuminance(color) {
    return (0.299 * color.meanR) + (0.587 * color.meanG) + (0.114 * color.meanB);
}

function colorSaturation(color) {
    const max = Math.max(color.meanR, color.meanG, color.meanB) / 255;
    const min = Math.min(color.meanR, color.meanG, color.meanB) / 255;
    if (max === 0) return 0;
    return (max - min) / max;
}

async function samplePosterPrimaryColor(imageBuffer) {
    try {
        const stats = await sharp(imageBuffer)
            .resize({ width: 80, height: 120, fit: "inside" })
            .stats();
        const dominant = stats.dominant || {};
        const meanR = clampColor(dominant.r ?? stats.channels?.[0]?.mean ?? 26);
        const meanG = clampColor(dominant.g ?? stats.channels?.[1]?.mean ?? 26);
        const meanB = clampColor(dominant.b ?? stats.channels?.[2]?.mean ?? 26);
        const color = { meanR, meanG, meanB };
        return { ...color, luminance: colorLuminance(color) };
    } catch {
        return { meanR: 26, meanG: 26, meanB: 26, luminance: 26 };
    }
}

/**
 * Estimate rendered text width given a font size.
 */
function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const char of text) {
        if ("iIl1., -".includes(char)) w += fontSize * 0.25;
        else if ("rftj".includes(char)) w += fontSize * 0.35;
        else if ("WMwm@".includes(char)) w += fontSize * 0.85;
        else if ("NQDOUCGRHKBAVXY".includes(char)) w += fontSize * 0.70;
        else if ("PESZT".includes(char)) w += fontSize * 0.60;
        else w += fontSize * 0.50;
    }
    return w;
}

/**
 * Build the frosted-glass tag composite operations for a given image.
 * The blur extraction and color sampling run in parallel.
 *
 * @param {Buffer} imageBuffer  - Source image buffer
 * @param {object} metadata     - sharp metadata for imageBuffer
 * @param {string} tagText      - Display string for the tag
 * @param {number} heightRatio  - Tag height as fraction of image height (0.08 poster / 0.15 backdrop)
 * @param {number} fontRatio    - Font size as fraction of tag height (0.60 poster / 0.75 backdrop)
 * @returns {Promise<Array>}    - Array of sharp composite operation objects
 */
async function buildTagComposites(imageBuffer, metadata, tagText, heightRatio, fontRatio) {
    const { width, height } = metadata;
    const tagHeight = Math.round(height * heightRatio);
    const fontSize = Math.round(tagHeight * fontRatio);
    const tagWidth = Math.round(estimateTextWidth(tagText, fontSize) + fontSize * 1.8);
    const startX = Math.round((width / 2) - (tagWidth / 2));
    const startY = height - tagHeight;
    const r = Math.round(tagHeight * 0.25);

    const extractLeft = Math.max(0, startX);
    const extractTop = Math.max(0, startY);
    const extractWidth = Math.min(tagWidth, width - extractLeft);
    const extractHeight = Math.min(tagHeight, height - extractTop);

    // ── Run color sampling and region blur in parallel ───────────────────────
    const [localColorInfo, primaryColorInfo, blurBuffer] = await Promise.all([
        sampleBottomHalf(imageBuffer, metadata),
        samplePosterPrimaryColor(imageBuffer),
        sharp(imageBuffer)
            .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
            .blur(15)
            .png()
            .toBuffer()
            .catch(() => null)
    ]);

    let tagColor = blendColor(localColorInfo, primaryColorInfo, 0.65);
    if (colorSaturation(tagColor) < 0.18 && colorSaturation(primaryColorInfo) >= 0.18) {
        tagColor = blendColor(tagColor, primaryColorInfo, 0.35);
    }
    const luminance = colorLuminance(tagColor);

    const textColor = luminance > 140 ? "#121212" : "#ffffff";

    const glassMixFactor = textColor === "#121212" ? 0.18 : 0.22;
    const blendTarget = textColor === "#121212"
        ? { meanR: 255, meanG: 255, meanB: 255 }
        : { meanR: 96, meanG: 96, meanB: 96 };
    const glassColor = blendColor(tagColor, blendTarget, glassMixFactor);

    const tagFillColor = `rgb(${glassColor.meanR}, ${glassColor.meanG}, ${glassColor.meanB})`;
    let tagFillOpacity = "0.52";

    const composites = [];
    const fontStack = "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

    // ── Frosted blur region ──────────────────────────────────────────────────
    if (blurBuffer) {
        const localPath = `M 0,${extractHeight} L ${extractWidth},${extractHeight} L ${extractWidth},${r} Q ${extractWidth},0 ${extractWidth - r},0 L ${r},0 Q 0,0 0,${r} Z`;
        const maskSvg = `<svg width="${extractWidth}" height="${extractHeight}"><path d="${localPath}" fill="white"/></svg>`;

        const shapedBlur = await sharp(blurBuffer)
            .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
            .png()
            .toBuffer();
        composites.push({ input: shapedBlur, top: extractTop, left: extractLeft });
    } else {
        tagFillOpacity = "0.85";
    }

    // ── Pill + text overlay ──────────────────────────────────────────────────
    const pillPath = `M ${startX},${height} L ${startX + tagWidth},${height} L ${startX + tagWidth},${startY + r} Q ${startX + tagWidth},${startY} ${startX + tagWidth - r},${startY} L ${startX + r},${startY} Q ${startX},${startY} ${startX},${startY + r} Z`;
    const tagSvg = `<svg width="${width}" height="${height}">
        <path d="${pillPath}" fill="${tagFillColor}" fill-opacity="${tagFillOpacity}"/>
        <text x="${width / 2}" y="${startY + (tagHeight / 2) + (fontSize * 0.35)}" text-anchor="middle"
              font-family="${fontStack}" font-size="${fontSize}" fill="${textColor}" font-weight="bold">${tagText}</text>
    </svg>`;
    composites.push({ input: Buffer.from(tagSvg), top: 0, left: 0 });

    return composites;
}

/**
 * Fetch, resize, and optionally round-corner a provider logo.
 * Returns a composite operation object, or null on failure.
 *
 * @param {string}  logoPath   - TMDB logo_path
 * @param {boolean} isNetwork  - Skip rounding for raw network logos
 * @param {number}  logoWidth  - Target pixel width
 * @param {number}  topOffset  - Composite top position
 * @param {number}  rightEdge  - Full image width (used to compute left position)
 * @param {number}  rightPad   - Padding from right edge
 * @param {string}  provider   - Clean provider name for targeted rendering
 */
async function buildLogoComposite(logoPath, isNetwork, logoWidth, topOffset, rightEdge, rightPad, provider = "") {
    try {
        const buf = await fetchImageBuffer(`https://image.tmdb.org/t/p/w154${logoPath}`, { retries: 1 });
        let resized = await sharp(buf)
            .resize({ width: logoWidth, withoutEnlargement: true })
            .png()
            .toBuffer();

        const meta = await sharp(resized).metadata();

        if (!isNetwork) {
            const maskRadius = Math.round(logoWidth * 0.2);
            const mask = Buffer.from(`<svg width="${meta.width}" height="${meta.height}">
                <rect x="0" y="0" width="${meta.width}" height="${meta.height}"
                      rx="${maskRadius}" ry="${maskRadius}" fill="white"/>
            </svg>`);
            resized = await sharp(resized)
                .composite([{ input: mask, blend: 'dest-in' }])
                .png()
                .toBuffer();
        }

        return {
            input: resized,
            top: topOffset,
            left: Math.round(rightEdge - meta.width - rightPad)
        };
    } catch (e) {
        console.error("Provider logo error:", e);
        return null;
    }
}

/**
 * Shared cache middleware + probabilistic cache cleanup.
 * Returns true if the request was served from cache (caller should return early).
 */
async function serveCached(cacheKey, res) {
    const cached = imageCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "public, max-age=86400");
        res.send(cached.buffer);
        return true;
    }

    const filePath = cacheFilePath(cacheKey);
    try {
        const stats = await fs.promises.stat(filePath);
        if (Date.now() < stats.mtimeMs + CACHE_TTL_MS) {
            const buffer = await fs.promises.readFile(filePath);
            imageCache.set(cacheKey, { buffer, expires: Date.now() + CACHE_TTL_MS });
            res.set("Content-Type", "image/png");
            res.set("Cache-Control", "public, max-age=86400");
            res.send(buffer);
            return true;
        }
    } catch (err) {
        // ignore missing cache file
    }

    if (Math.random() < 0.05) {
        for (const [k, v] of imageCache.entries()) {
            if (Date.now() > v.expires) imageCache.delete(k);
        }
    }
    return false;
}

function cacheAndSend(cacheKey, buffer, res) {
    imageCache.set(cacheKey, { buffer, expires: Date.now() + CACHE_TTL_MS });
    fs.promises.writeFile(cacheFilePath(cacheKey), buffer).catch(() => { });
    if (imageCache.size > 500) {
        const oldestKey = imageCache.keys().next().value;
        imageCache.delete(oldestKey);
    }
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buffer);
}

// ─── Catalog handler (unchanged logic) ───────────────────────────────────────

builder.defineCatalogHandler(async (args) => {
    const { type, id, extra } = args;
    const config = extra?.config || {};

    const userConfig = {
        landscapeTags: false,
        landscapeLogos: false,
        landscapeRanked: false,
        landscapePosterLang: config.landscapePosterLang || config.posterLang || "en",
        portraitTags: config.portraitTags !== undefined ? config.portraitTags !== "false" : config.tags !== "false",
        portraitLogos: config.portraitLogos !== undefined ? config.portraitLogos === "true" : config.logos === "true",
        portraitMovieLogos: config.portraitMovieLogos !== undefined ? config.portraitMovieLogos === "true" : (config.portraitLogos !== undefined ? config.portraitLogos === "true" : config.logos === "true"),
        portraitSeriesLogos: config.portraitSeriesLogos !== undefined ? config.portraitSeriesLogos === "true" : (config.portraitLogos !== undefined ? config.portraitLogos === "true" : config.logos === "true"),
        portraitTheatersLogos: config.portraitTheatersLogos !== undefined ? config.portraitTheatersLogos === "true" : (config.portraitMovieLogos !== undefined ? config.portraitMovieLogos === "true" : (config.portraitLogos !== undefined ? config.portraitLogos === "true" : config.logos === "true")),
        portraitRanked: config.portraitRanked === "true" || config.ranked === "true",
        portraitMovieRanked: config.portraitMovieRanked !== undefined ? config.portraitMovieRanked === "true" : (config.portraitRanked === "true" || config.ranked === "true"),
        portraitSeriesRanked: config.portraitSeriesRanked !== undefined ? config.portraitSeriesRanked === "true" : (config.portraitRanked === "true" || config.ranked === "true"),
        portraitTheatersRanked: config.portraitTheatersRanked !== undefined ? config.portraitTheatersRanked === "true" : (config.portraitRanked === "true" || config.ranked === "true"),
        top10Only: config.top10Only === "true",
        movieTop10Only: config.movieTop10Only !== undefined ? config.movieTop10Only === "true" : config.top10Only === "true",
        seriesTop10Only: config.seriesTop10Only !== undefined ? config.seriesTop10Only === "true" : config.top10Only === "true",
        portraitPosterLang: config.portraitPosterLang || config.posterLang || "en",
        digitalOnly: config.digitalOnly === "true",
        tmdbTrendingToday: config.tmdbTrendingToday === "true",
        listLang: config.listLang || "en",
        traktCatalog: normalizeTraktCatalogInput(config.traktCatalog),
        traktShowsCatalog: normalizeTraktCatalogInput(config.traktShowsCatalog || config.traktSeriesCatalog),
        traktMoviesCatalog: normalizeTraktCatalogInput(config.traktMoviesCatalog),
        traktTheatersCatalog: normalizeTraktCatalogInput(config.traktTheatersCatalog),
        addonUrl: config.addonUrl || ADDON_URL
    };

    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const activePublicCatalog = id === "calendar_lite_theaters"
        ? userConfig.traktTheatersCatalog
        : type === 'series'
            ? (userConfig.traktShowsCatalog || userConfig.traktCatalog)
            : (userConfig.traktMoviesCatalog || userConfig.traktCatalog);
    let finalItems = [];
    let seenIds = new Set();
    let page = 1;
    const usePublicCatalog = !!activePublicCatalog;
    const useTmdbTrendingToday = !usePublicCatalog && id !== "calendar_lite_theaters" && userConfig.tmdbTrendingToday;
    if (!usePublicCatalog && !useTmdbTrendingToday) {
        return { metas: [] };
    }

    const maxPages = useTmdbTrendingToday ? 5 : 1;
    const catalogLimit = useTmdbTrendingToday ? 10 : Infinity;
    const TODAY = new Date();

    while (finalItems.length < catalogLimit && page <= maxPages) {
        const data = {
            results: usePublicCatalog
                ? await fetchCatalogTmdbSeeds(activePublicCatalog, type)
                : await fetchTmdbTrendingTodaySeeds(type, page)
        };
        if (!data.results || data.results.length === 0) break;

        let pageItems = data.results.filter(item => {
            if (seenIds.has(item.id)) return false;

            let keep = true;
            if (!usePublicCatalog) {
                const langs = userConfig.listLang.split(',');
                keep = false;
                if (langs.includes('all')) keep = true;
                else if (langs.includes('non-en') && item.original_language !== 'en') keep = true;
                else if (langs.includes(item.original_language)) keep = true;
            }

            if (!keep) return false;

            seenIds.add(item.id);
            return true;
        });

        if (pageItems.length > 0) {
            const detailsData = await Promise.all(pageItems.map(async (item) => {
                try {
                    return await fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${item.id}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`);
                } catch { return null; }
            }));
            pageItems.forEach((item, index) => {
                const details = detailsData[index];
                item._details = details;
                if (details) {
                    item.title = item.title || details.title;
                    item.name = item.name || details.name;
                    item.overview = item.overview || details.overview;
                    item.poster_path = item.poster_path || details.poster_path;
                    item.backdrop_path = item.backdrop_path || details.backdrop_path;
                    item.genre_ids = item.genre_ids || details.genres?.map(g => g.id) || [];
                    item.original_language = item.original_language || details.original_language;
                }
            });
        }

        if (type === 'movie' && pageItems.length > 0) {
            const releaseDatesData = await Promise.all(pageItems.map(async (movie) => {
                return fetchMovieReleaseDates(movie);
            }));

            pageItems.forEach((item, index) => {
                const dates = releaseDatesData[index] || {};
                item._earliestTheatrical = dates.earliestTheatrical;
                item._earliestDigital = dates.earliestDigital;
                item._earliestPhysical = dates.earliestPhysical;
            });

            if ((userConfig.digitalOnly || useTmdbTrendingToday) && !usePublicCatalog) {
                pageItems = pageItems.filter(item => {
                    // Prevent TMDB metadata errors: if a future digital release exists,
                    // it is not truly out yet, regardless of erroneous past physical dates.
                    if (item._earliestDigital && item._earliestDigital > TODAY) return false;

                    const hasDigital = item._earliestDigital && item._earliestDigital <= TODAY;
                    const hasPhysical = item._earliestPhysical && item._earliestPhysical <= TODAY;
                    if (useTmdbTrendingToday) return hasDigital;
                    return hasDigital || hasPhysical;
                });
            }

            pageItems.forEach(item => {
                const needsTags = userConfig.landscapeTags || userConfig.portraitTags;
                if (needsTags) {
                    const daysSinceDigital = (item._earliestDigital && item._earliestDigital <= TODAY) ? diffDays(TODAY, item._earliestDigital) : null;
                    const daysSinceTheatrical = (item._earliestTheatrical && item._earliestTheatrical <= TODAY) ? diffDays(TODAY, item._earliestTheatrical) : null;
                    const daysUntilDigital = (item._earliestDigital && item._earliestDigital > TODAY) ? diffDays(item._earliestDigital, TODAY) : null;
                    const isCurrentTheatricalCatalog = id === "calendar_lite_theaters";

                    if (
                        isCurrentTheatricalCatalog &&
                        daysSinceTheatrical !== null &&
                        daysSinceTheatrical <= 45 &&
                        daysSinceDigital === null &&
                        (daysUntilDigital === null || daysUntilDigital > 14)
                    ) {
                        item._tag = "in_theaters";
                    } else if (daysSinceDigital !== null) {
                        item._tag = daysSinceDigital <= 7 ? "new_release" : "new_movie";
                    } else if (!item._earliestDigital || item._earliestDigital > TODAY) {
                        if (item._earliestDigital) {
                            const formattedDate = formatFutureDate(item._earliestDigital);
                            item._tag = daysUntilDigital <= 14
                                ? `coming_date_${formattedDate.replace(' ', '_')}`
                                : `coming_soon_date_${formattedDate.replace(' ', '_')}`;
                        } else {
                            item._tag = "coming_soon";
                        }
                    } else {
                        item._tag = "none";
                    }
                } else {
                    item._tag = "none";
                }
            });

        } else if (type === 'series' && pageItems.length > 0) {
            const needsTags = userConfig.landscapeTags || userConfig.portraitTags;
            if (needsTags) {
                const tvDetailsData = await Promise.all(pageItems.map(async (show) => {
                    try {
                        const data = await fetchTmdbJson(`https://api.themoviedb.org/3/tv/${show.id}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`);

                        let nextEp = data.next_episode_to_air;
                        if (nextEp && nextEp.air_date) {
                            const nextAirDate = parseLocal(nextEp.air_date);
                            if (nextAirDate <= TODAY) {
                                const currentSeason = data.seasons?.find(s => s.season_number === nextEp.season_number);
                                const expectedCount = currentSeason?.episode_count || 0;
                                if (expectedCount > 0 && nextEp.episode_number < expectedCount) {
                                    try {
                                        const seasonData = await fetchTmdbJson(`https://api.themoviedb.org/3/tv/${show.id}/season/${nextEp.season_number}?api_key=${TMDB_API_KEY}`);
                                        if (seasonData.episodes) {
                                            const validEps = seasonData.episodes.filter(ep => ep.air_date && parseLocal(ep.air_date) <= TODAY);
                                            if (validEps.length > 0) {
                                                const latest = validEps[validEps.length - 1];
                                                if (latest.episode_number > nextEp.episode_number) {
                                                    data.next_episode_to_air = latest;
                                                }
                                            }
                                        }
                                    } catch { /* ignore */ }
                                }
                            }
                        }
                        return data;
                    } catch { return null; }
                }));

                for (let index = 0; index < pageItems.length; index++) {
                    const item = pageItems[index];
                    const tvData = tvDetailsData[index];
                    if (!tvData) continue;
                    item._details = tvData; // Ensure details are attached for later use

                    const episodeTimeline = await fetchSeriesEpisodeTimeline(tvData, item._traktId, TODAY);
                    let lastEp = episodeTimeline?.lastEp || tmdbEpisodeFields(tvData.last_episode_to_air);
                    let nextEp = episodeTimeline?.nextEp || tmdbEpisodeFields(tvData.next_episode_to_air);

                    if (nextEp && nextEp.air_date) {
                        const nextAirDate = parseLocal(nextEp.air_date);
                        if (nextAirDate <= TODAY) { lastEp = nextEp; nextEp = null; }
                    }

                    let isFinale = false;
                    if (lastEp) {
                        const currentSeason = tvData.seasons?.find(s => s.season_number === lastEp.season_number);
                        const expectedCount = currentSeason?.episode_count || 0;
                        if (lastEp.episode_type) {
                            isFinale = lastEp.episode_type === "finale";
                        } else if (expectedCount > 0 && lastEp.episode_number >= expectedCount) {
                            isFinale = true;
                        } else if (!nextEp && lastEp.episode_number > 1) {
                            if (expectedCount === 0 || lastEp.episode_number >= expectedCount) isFinale = true;
                        }
                    }

                    const firstAir = episodeTimeline?.firstAir || parseLocal(tvData.first_air_date);
                    const lastAir = lastEp?.air_date ? parseLocal(lastEp.air_date) : parseLocal(tvData.last_air_date);
                    const latestSeason = tvData.seasons?.slice().reverse().find(s => s.season_number > 0);
                    const seasonAir = episodeTimeline?.seasonAir || (latestSeason?.air_date ? parseLocal(latestSeason.air_date) : null);

                    let itemTag = null, futureDate = null;

                    if (firstAir && firstAir > TODAY) {
                        futureDate = firstAir;
                    } else if (nextEp && nextEp.episode_number === 1) {
                        futureDate = parseLocal(nextEp.air_date);
                    }

                    if (futureDate) {
                        const daysUntil = diffDays(futureDate, TODAY);
                        if (daysUntil <= 14) {
                            itemTag = `coming_date_${formatFutureDate(futureDate).replace(' ', '_')}`;
                        } else {
                            itemTag = `coming_soon_date_${formatFutureDate(futureDate).replace(' ', '_')}`;
                        }
                    }

                    if (!itemTag && nextEp?.air_date) {
                        const nextAirDate = parseLocal(nextEp.air_date);
                        if (nextAirDate > TODAY && diffDays(nextAirDate, TODAY) <= 7) {
                            const nextSeason = tvData.seasons?.find(s => s.season_number === nextEp.season_number);
                            const expectedCount = nextSeason?.episode_count || 0;
                            let isNextFinale = nextEp.episode_type
                                ? nextEp.episode_type === "finale"
                                : (expectedCount > 0 && nextEp.episode_number >= expectedCount);
                            if (isNextFinale) {
                                itemTag = `finale_date_${formatFutureDate(nextAirDate).replace(' ', '_')}`;
                            }
                        }
                    }

                    if (!itemTag) {
                        const nextAirDate = nextEp?.air_date ? parseLocal(nextEp.air_date) : null;
                        const hasNextEpisodeTag = nextAirDate && nextAirDate > TODAY && diffDays(nextAirDate, TODAY) <= 7 && lastAir && diffDays(TODAY, lastAir) >= 4;

                        if (hasNextEpisodeTag) {
                            itemTag = `next_episode_date_${formatFutureDate(nextAirDate).replace(' ', '_')}`;
                        } else if (firstAir && firstAir <= TODAY && diffDays(TODAY, firstAir) <= 3) {
                            itemTag = "new_series";
                        } else if (seasonAir && seasonAir <= TODAY && diffDays(TODAY, seasonAir) <= 3) {
                            itemTag = "new_season";
                        } else if (isFinale && lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 30) {
                            if (tvData.status === "Ended" || tvData.status === "Canceled") {
                                itemTag = "series_finale";
                            } else {
                                itemTag = "season_finale";
                            }
                        } else if (lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 3) {
                            itemTag = "new_episode";
                        } else if ((tvData.status === "Ended" || tvData.status === "Canceled") &&
                            tvData.number_of_seasons > 1 && lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 30) {
                            itemTag = "final_season";
                        }
                    }

                    item._tag = itemTag || "none";
                }
            } else {
                pageItems.forEach(item => item._tag = "none");
            }
        }

        finalItems.push(...pageItems);
        if (finalItems.length > catalogLimit) finalItems = finalItems.slice(0, catalogLimit);
        page++;
    }

    const isTheatersCatalog = id === "calendar_lite_theaters";
    const limitCatalogToTop10 = useTmdbTrendingToday
        ? true
        : type === 'series'
        ? userConfig.seriesTop10Only
        : isTheatersCatalog
            ? false
            : userConfig.movieTop10Only;
    const displayItems = limitCatalogToTop10 ? finalItems.slice(0, 10) : finalItems;
    const metas = displayItems.map((item, index) => {
        const rank = index + 1;
        let finalPosterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
        const imdbId = item._details?.imdb_id || item._details?.external_ids?.imdb_id;

        const pTag = userConfig.portraitTags ? (item._tag || 'none') : 'none';
        const portraitLogosForCatalog = type === 'series'
            ? userConfig.portraitSeriesLogos
            : isTheatersCatalog
                ? userConfig.portraitTheatersLogos
                : userConfig.portraitMovieLogos;
        const portraitRankedForCatalog = type === 'series'
            ? userConfig.portraitSeriesRanked
            : isTheatersCatalog
                ? userConfig.portraitTheatersRanked
                : userConfig.portraitMovieRanked;
        if (portraitRankedForCatalog || userConfig.portraitTags || portraitLogosForCatalog || userConfig.portraitPosterLang !== 'en') {
            finalPosterUrl = `${userConfig.addonUrl}/proxy-image-poster/${type}/${item.id}/${pTag}/${portraitRankedForCatalog ? rank : 'none'}/${userConfig.portraitPosterLang}/${portraitLogosForCatalog ? '1' : '0'}.png?v=${IMAGE_VERSION}`;
        }

        let itemGenres = item.genre_ids ? item.genre_ids.map(gId => genreMap[gId]).filter(Boolean) : [];
        if (userConfig.listLang === 'non-en' && item.original_language) {
            try {
                const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(item.original_language);
                if (langName) itemGenres.unshift(langName);
            } catch {
                itemGenres.unshift(item.original_language.toUpperCase());
            }
        }

        const lTag = userConfig.landscapeTags ? (item._tag || 'none') : 'none';

        return {
            id: imdbId || `tmdb:${item.id}`,
            _tmdbId: item.id,
            name: item.title || item.name,
            type: type,
            genres: itemGenres,
            description: item.overview || "",
            background: `${userConfig.addonUrl}/proxy-image-backdrop/${type}/${item.id}/${lTag}/${userConfig.landscapeRanked ? rank : 'none'}/${userConfig.landscapePosterLang}/${userConfig.landscapeLogos ? '1' : '0'}.png`,
            poster: finalPosterUrl
        };
    });

    return { metas };
});

// ─── Backdrop route ───────────────────────────────────────────────────────────

app.get(
    ['/proxy-image-backdrop/:type/:id/:tag/:lang.png',
        '/proxy-image-backdrop/:type/:id/:tag/:lang/:logos.png'],
    async (req, res) => {
        const { type, id, tag, lang, logos } = req.params;
        const newUrl = `/proxy-image-backdrop/${type}/${id}/${tag}/none/${lang}${logos ? `/${logos}` : ''}.png`;
        return res.redirect(301, newUrl);
    }
);

app.get(
    ['/proxy-image-backdrop/:type/:id/:tag/:rank/:lang.png',
        '/proxy-image-backdrop/:type/:id/:tag/:rank/:lang/:logos.png'],
    async (req, res) => {
        if (await serveCached(req.originalUrl, res)) return;

        try {
            const { type, id, tag, rank, lang, logos } = req.params;
            const tmdbType = type === 'series' ? 'tv' : 'movie';
            const showLogos = logos === '1';
            const tagText = parseTagText(tag);
            const drawTag = !!tagText;
            const drawRank = rank && rank !== 'none';

            // ── 1. Fetch TMDB metadata ────────────────────────────────────────
            const details = await fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}?api_key=${TMDB_API_KEY}`);
            const originalLang = details.original_language;

            const fallbackLangs = ['en', 'null', 'ja', 'ko', 'es', 'fr', 'de', 'hi', 'it', 'pt', 'ru', 'zh', 'th', 'tr', 'pl', 'nl', 'sv', 'ar'];
            const tmdbLangsSet = [...new Set([lang, originalLang, ...fallbackLangs])].filter(Boolean);
            const allowedLangs = tmdbLangsSet.map(l => l === 'null' ? null : l);
            const tmdbLangs = tmdbLangsSet.join(',');

            const [images, providers] = await Promise.all([
                fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}/images?api_key=${TMDB_API_KEY}&include_image_language=${tmdbLangs}`),
                showLogos ? fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}/watch/providers?api_key=${TMDB_API_KEY}`) : Promise.resolve(null)
            ]);

            if (providers) details['watch/providers'] = providers;

            if (images.backdrops) {
                images.backdrops = images.backdrops.filter(b => allowedLangs.includes(b.iso_639_1));
            }

            const backdropLangToUse = lang === 'null' ? null : lang;
            const backdrop = images.backdrops?.find(b => b.iso_639_1 === backdropLangToUse)
                || (originalLang && images.backdrops?.find(b => b.iso_639_1 === originalLang))
                || images.backdrops?.find(b => b.iso_639_1 === null)
                || images.backdrops?.[0];

            if (!backdrop?.file_path) {
                return res.redirect(301, 'https://via.placeholder.com/1280x720.png?text=No+Background+Available');
            }

            let titleLogo = null;
            if (lang !== 'null' && backdrop.iso_639_1 === null && images.logos && images.logos.length > 0) {
                titleLogo = images.logos.find(l => l.iso_639_1 === lang)
                    || (originalLang && images.logos.find(l => l.iso_639_1 === originalLang))
                    || images.logos.find(l => l.iso_639_1 === 'en')
                    || images.logos[0];
            }

            // Resolve logo info (sync, no fetch yet)
            const logoInfo = showLogos ? resolveProviderLogoInfo(tmdbType, details) : null;

            // Fast path: nothing to draw → just redirect
            if (!drawTag && !drawRank && !logoInfo && !titleLogo) {
                return res.redirect(301, `https://image.tmdb.org/t/p/original${backdrop.file_path}`);
            }

            // ── 2. Fetch backdrop image + provider logo in parallel ───────────
            const backdropUrl = `https://image.tmdb.org/t/p/w1280${backdrop.file_path}`;
            let backdropBuffer;
            try {
                backdropBuffer = await fetchImageBuffer(backdropUrl);
            } catch (error) {
                console.warn("Backdrop fetch timed out; redirecting to TMDB image:", error.message);
                return res.redirect(302, backdropUrl);
            }
            const logoCompositeResult = logoInfo;

            const backdropImage = sharp(backdropBuffer);
            const metadata = await backdropImage.metadata();
            const { width } = metadata;

            // ── 3. Build rank SVG (sync, zero I/O) ───────────────────────────
            let rankComposite = null;
            if (drawRank) {
                const fontSize = Math.round(metadata.height * 0.16);
                const paddingTop = Math.round(metadata.height * 0.045);
                const paddingLeft = Math.round(width * 0.045);
                const fontStack = "'Arial Black', 'Segoe UI Black', 'Aptos Black', Impact, 'SF Pro Display', Arial, sans-serif";

                const rankSvg = `<svg width="${width}" height="${metadata.height}">
                    <defs>
                        <linearGradient id="rankGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%"   style="stop-color:#ffffff;stop-opacity:1"/>
                            <stop offset="60%"  style="stop-color:#c0c0c0;stop-opacity:1"/>
                            <stop offset="100%" style="stop-color:#808080;stop-opacity:1"/>
                        </linearGradient>
                        <filter id="rankShadow" x="-10%" y="-10%" width="120%" height="120%">
                            <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
                            <feOffset dx="2" dy="2" result="offsetblur"/>
                            <feFlood flood-color="black" flood-opacity="0.65"/>
                            <feComposite in2="offsetblur" operator="in"/>
                            <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
                        </filter>
                        <radialGradient id="shimmerGradient" cx="0%" cy="0%" r="100%" fx="0%" fy="0%">
                            <stop offset="0%"   style="stop-color:black;stop-opacity:0.6"/>
                            <stop offset="40%"  style="stop-color:black;stop-opacity:0.3"/>
                            <stop offset="100%" style="stop-color:black;stop-opacity:0"/>
                        </radialGradient>
                    </defs>
                    <rect x="0" y="0" width="${width * 0.32}" height="${fontSize * 1.35}" fill="url(#shimmerGradient)"/>
                    <text x="${paddingLeft}" y="${paddingTop + fontSize / 1.05}" text-anchor="start"
                          font-family="${fontStack}" font-size="${fontSize}"
                          fill="url(#rankGradient)" fill-opacity="0.92" font-weight="900"
                          filter="url(#rankShadow)">${rank}</text>
                </svg>`;

                rankComposite = { input: Buffer.from(rankSvg), top: 0, left: 0 };
            }

            // ── 4. Tag composites + logo fetch run in parallel ────────────────
            const backdropLogoPlacement = logoInfo
                ? logoPlacement(
                    Math.round(width * 0.10),
                    Math.round(metadata.height * 0.04),
                    Math.round(metadata.height * 0.04),
                    logoInfo.provider
                )
                : null;
            const [tagComposites, logoComposite, titleLogoComposite] = await Promise.all([
                drawTag
                    ? buildTagComposites(backdropBuffer, metadata, tagText, 0.15, 0.75)
                    : Promise.resolve([]),
                logoInfo
                    ? buildLogoComposite(
                        logoInfo.path,
                        logoInfo.isNetwork,
                        backdropLogoPlacement.width,
                        backdropLogoPlacement.top,
                        width,
                        backdropLogoPlacement.rightPad,
                        logoInfo.provider
                    )
                    : Promise.resolve(null),
                titleLogo
                    ? (async () => {
                        try {
                            const buf = await fetchImageBuffer(`https://image.tmdb.org/t/p/original${titleLogo.file_path}`, { retries: 1 });
                            const targetWidth = Math.round(width * 0.50);
                            const maxHeight = Math.round(metadata.height * 0.50);
                            let resized = await sharp(buf)
                                .resize({ width: targetWidth, height: maxHeight, fit: 'inside' })
                                .png()
                                .toBuffer();
                            const meta = await sharp(resized).metadata();
                            const paddingLeft = Math.round(width * 0.05);
                            const paddingBottom = Math.round(metadata.height * 0.20);

                            const targetLeft = paddingLeft;
                            const targetTop = metadata.height - meta.height - paddingBottom;

                            // Sharp throws an error if the composite overlay is larger than the base image
                            const extractLeft = Math.max(0, -targetLeft);
                            const extractTop = Math.max(0, -targetTop);
                            const extractRight = Math.min(meta.width, width - targetLeft);
                            const extractBottom = Math.min(meta.height, metadata.height - targetTop);

                            const extractWidth = extractRight - extractLeft;
                            const extractHeight = extractBottom - extractTop;

                            if (extractWidth <= 0 || extractHeight <= 0) return null;

                            if (extractWidth < meta.width || extractHeight < meta.height) {
                                resized = await sharp(resized)
                                    .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
                                    .toBuffer();
                            }

                            return {
                                input: resized,
                                left: targetLeft + extractLeft,
                                top: targetTop + extractTop
                            };
                        } catch (e) {
                            console.error("Title logo error:", e);
                            return null;
                        }
                    })()
                    : Promise.resolve(null)
            ]);

            const compositeOperations = [
                ...(rankComposite ? [rankComposite] : []),
                ...tagComposites,
                ...(titleLogoComposite ? [titleLogoComposite] : []),
                ...(logoComposite ? [logoComposite] : [])
            ];

            const finalImageBuffer = await backdropImage
                .composite(compositeOperations)
                .png()
                .toBuffer();

            cacheAndSend(req.originalUrl, finalImageBuffer, res);
        } catch (error) {
            console.error("Backdrop generation error:", error);
            res.status(500).send("Error generating image");
        }
    }
);

// ─── Poster route ─────────────────────────────────────────────────────────────

app.get(
    ['/proxy-image-poster/:type/:id/:tag/:rank/:lang.png',
        '/proxy-image-poster/:type/:id/:tag/:rank/:lang/:logos.png'],
    async (req, res) => {
        if (await serveCached(req.originalUrl, res)) return;

        try {
            const { type, id, tag, rank, lang, logos } = req.params;
            const tmdbType = type === 'series' ? 'tv' : 'movie';
            const showLogos = logos === '1';
            const tagText = parseTagText(tag);
            const drawTag = !!tagText;
            const drawRank = rank && rank !== 'none';

            // ── 1. Fetch TMDB metadata ────────────────────────────────────────
            const details = await fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}?api_key=${TMDB_API_KEY}`);
            const originalLang = details.original_language;

            const fallbackLangs = ['en', 'null', 'ja', 'ko', 'es', 'fr', 'de', 'hi', 'it', 'pt', 'ru', 'zh', 'th', 'tr', 'pl', 'nl', 'sv', 'ar'];
            const tmdbLangsSet = [...new Set([lang, originalLang, ...fallbackLangs])].filter(Boolean);
            const allowedLangs = tmdbLangsSet.map(l => l === 'null' ? null : l);
            const tmdbLangs = tmdbLangsSet.join(',');

            const [images, providers] = await Promise.all([
                fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}/images?api_key=${TMDB_API_KEY}&include_image_language=${tmdbLangs}`),
                showLogos ? fetchTmdbJson(`https://api.themoviedb.org/3/${tmdbType}/${id}/watch/providers?api_key=${TMDB_API_KEY}`) : Promise.resolve(null)
            ]);

            if (providers) details['watch/providers'] = providers;

            if (images.posters) {
                images.posters = images.posters.filter(p => allowedLangs.includes(p.iso_639_1));
            }

            const posterLangToUse = lang === 'null' ? null : lang;
            const poster = images.posters?.find(p => p.iso_639_1 === posterLangToUse)
                || (originalLang && images.posters?.find(p => p.iso_639_1 === originalLang))
                || images.posters?.find(p => p.iso_639_1 === null)
                || images.posters?.find(p => p.iso_639_1 === 'en')
                || images.posters?.[0];

            if (!poster?.file_path) {
                return res.redirect(301, 'https://via.placeholder.com/500x750.png?text=Poster+Unavailable');
            }

            // Resolve logo info (sync, no fetch yet)
            const logoInfo = showLogos ? resolveProviderLogoInfo(tmdbType, details) : null;

            // Fast path: nothing to draw → just redirect
            if (!drawTag && !drawRank && !logoInfo) {
                return res.redirect(301, `https://image.tmdb.org/t/p/w500${poster.file_path}`);
            }

            // ── 2. Fetch poster image (logo fetch is deferred until we have width) ──
            const posterUrl = `https://image.tmdb.org/t/p/w500${poster.file_path}`;
            let posterBuffer;
            try {
                posterBuffer = await fetchImageBuffer(posterUrl);
            } catch (error) {
                console.warn("Poster fetch timed out; redirecting to TMDB image:", error.message);
                return res.redirect(302, posterUrl);
            }

            const posterImage = sharp(posterBuffer);
            const metadata = await posterImage.metadata();
            const { width } = metadata;

            // ── 3. Build rank SVG (sync, zero I/O) ───────────────────────────
            let rankComposite = null;
            if (drawRank) {
                const fontSize = Math.round(width * 0.22);
                const paddingTop = Math.round(width * 0.065);
                const paddingLeft = Math.round(width * 0.07);
                const fontStack = "'Arial Black', 'Segoe UI Black', 'Aptos Black', Impact, 'SF Pro Display', Arial, sans-serif";

                const rankSvg = `<svg width="${width}" height="${metadata.height}">
                    <defs>
                        <linearGradient id="rankGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%"   style="stop-color:#ffffff;stop-opacity:1"/>
                            <stop offset="60%"  style="stop-color:#c0c0c0;stop-opacity:1"/>
                            <stop offset="100%" style="stop-color:#808080;stop-opacity:1"/>
                        </linearGradient>
                        <filter id="rankShadow" x="-10%" y="-10%" width="120%" height="120%">
                            <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
                            <feOffset dx="2" dy="2" result="offsetblur"/>
                            <feFlood flood-color="black" flood-opacity="0.65"/>
                            <feComposite in2="offsetblur" operator="in"/>
                            <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
                        </filter>
                        <radialGradient id="shimmerGradient" cx="0%" cy="0%" r="100%" fx="0%" fy="0%">
                            <stop offset="0%"   style="stop-color:black;stop-opacity:0.6"/>
                            <stop offset="40%"  style="stop-color:black;stop-opacity:0.3"/>
                            <stop offset="100%" style="stop-color:black;stop-opacity:0"/>
                        </radialGradient>
                    </defs>
                    <rect x="0" y="0" width="${width * 0.42}" height="${fontSize * 1.55}" fill="url(#shimmerGradient)"/>
                    <text x="${paddingLeft}" y="${paddingTop + fontSize / 1.15}" text-anchor="start"
                          font-family="${fontStack}" font-size="${fontSize}"
                          fill="url(#rankGradient)" fill-opacity="0.92" font-weight="900"
                          filter="url(#rankShadow)">${rank}</text>
                </svg>`;

                rankComposite = { input: Buffer.from(rankSvg), top: 0, left: 0 };
            }

            // ── 4. Tag composites + logo fetch run in parallel ────────────────
            const posterLogoPlacement = logoInfo
                ? logoPlacement(
                    Math.round(width * 0.15),
                    Math.round(width * 0.04),
                    Math.round(width * 0.04),
                    logoInfo.provider
                )
                : null;
            const [tagComposites, logoComposite] = await Promise.all([
                drawTag
                    ? buildTagComposites(posterBuffer, metadata, tagText, 0.08, 0.60)
                    : Promise.resolve([]),
                logoInfo
                    ? buildLogoComposite(
                        logoInfo.path,
                        logoInfo.isNetwork,
                        posterLogoPlacement.width,
                        posterLogoPlacement.top,
                        width,
                        posterLogoPlacement.rightPad,
                        logoInfo.provider
                    )
                    : Promise.resolve(null)
            ]);

            const compositeOperations = [
                ...(rankComposite ? [rankComposite] : []),
                ...tagComposites,
                ...(logoComposite ? [logoComposite] : [])
            ];

            const finalImageBuffer = await posterImage
                .composite(compositeOperations)
                .png()
                .toBuffer();

            cacheAndSend(req.originalUrl, finalImageBuffer, res);
        } catch (error) {
            console.error("Poster generation error:", error);
            res.status(500).send("Error generating image");
        }
    }
);

// ─── Config UI ────────────────────────────────────────────────────────────────

const configUI = `<!DOCTYPE html>
<html>
<head>
    <title>Coming Soon</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><circle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%238b0000%22/><path d=%22M25 70 l15 -25 l15 15 l20 -30%22 fill=%22none%22 stroke=%22white%22 stroke-width=%228%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/><path d=%22M55 30 h20 v20%22 fill=%22none%22 stroke=%22white%22 stroke-width=%228%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/></svg>">
    <style>
        body { font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #121212; color: #fff; margin: 0; padding: 20px; box-sizing: border-box; height: 100vh; overflow: hidden; }
        .wrapper { display: flex; flex-direction: row; gap: 30px; width: 100%; height: 100%; max-width: none; align-items: stretch; }
        .container { background-color: #1e1e1e; padding: 30px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.5); flex: 0 0 420px; min-width: 420px; box-sizing: border-box; display: flex; flex-direction: column; height: 100%; max-height: 100%; overflow-y: auto; }
        .preview-container { background-color: #1e1e1e; padding: 30px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.5); flex: 1; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; height: 100%; max-height: 100%; overflow-y: auto; }
        h2 { margin-top: 0; text-align: center; color: #e0e0e0; margin-bottom: 25px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 600; font-size: 14px; color: #b3b3b3; }
        select { width: 100%; padding: 12px; border-radius: 6px; border: 1px solid #333; background: #2a2a2a; color: #fff; font-size: 14px; outline: none; box-sizing: border-box; }
        select:focus { border-color: #8b0000; }
        .checkbox-group { display: flex; align-items: center; background: #2a2a2a; padding: 12px; border-radius: 6px; border: 1px solid #333; cursor: pointer; margin-bottom: 10px; }
        .checkbox-group input { margin-right: 12px; width: 18px; height: 18px; cursor: pointer; accent-color: #8b0000; }
        .checkbox-group span { margin-bottom: 0; cursor: pointer; color: #fff; font-size: 15px; }
        .link-container { display: flex; gap: 10px; margin-top: 5px; }
        .link-container input { flex-grow: 1; padding: 12px; border-radius: 6px; border: 1px solid #333; background: #2a2a2a; color: #aaa; font-size: 13px; outline: none; }
        .link-container button { width: auto; margin-top: 0; padding: 0 20px; background-color: #8b0000; color: #fff; font-size: 14px; font-weight: 700; border: none; border-radius: 6px; cursor: pointer; transition: background .2s; }
        .link-container button:hover { background-color: #660000; }
        .trakt-add-row { display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 12px; }
        .trakt-add-buttons { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
        .trakt-add-row input, .trakt-slot input { width: 100%; padding: 12px; border-radius: 6px; border: 1px solid #333; background: #2a2a2a; color: #fff; font-size: 14px; outline: none; box-sizing: border-box; }
        .trakt-slot input + input { margin-top: 8px; }
        .trakt-add-row button { min-height: 42px; padding: 0 12px; border: none; border-radius: 6px; background: #333; color: #fff; font-weight: 700; cursor: pointer; }
        .trakt-add-row button:hover { background: #444; }
        .trakt-slot { margin-bottom: 12px; }
        .trakt-slot label { display: flex; justify-content: space-between; align-items: center; }
        .trakt-clear { border: none; background: transparent; color: #b3b3b3; cursor: pointer; font-size: 12px; }
        .trakt-clear:hover { color: #fff; }
        .main-btn { width: 100%; padding: 14px; border: none; border-radius: 6px; background-color: #8b0000; color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; transition: background .2s; }
        .main-btn:hover { background-color: #660000; }
        .preview-section { width: 100%; }
        .row-title { color: #e0e0e0; margin: 0 0 15px 0; font-size: 16px; border-bottom: 1px solid #333; padding-bottom: 8px; }
        .horizontal-scroll { display: flex; overflow-x: auto; gap: 15px; padding-bottom: 15px; align-items: flex-start; }
        .horizontal-scroll::-webkit-scrollbar { height: 8px; }
        .horizontal-scroll::-webkit-scrollbar-track { background: #2a2a2a; border-radius: 4px; }
        .horizontal-scroll::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }
        .horizontal-scroll::-webkit-scrollbar-thumb:hover { background: #8b0000; }
        .item-card { display: flex; flex-direction: column; gap: 10px; text-decoration: none; }
        .item-card.portrait { width: 150px; }
        .item-card img { object-fit: cover; border-radius: 6px; background-color: #2a2a2a; }
        .item-card.portrait img { width: 150px; aspect-ratio: 2/3; }
        .item-title { font-size: 13px; color: #b3b3b3; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; margin: 0; }
        .loading { color: #aaa; font-style: italic; font-size: 14px; padding: 20px 0; text-align: center; width: 100%; align-self: center; }
        .multi-select { position: relative; width: 100%; margin-bottom: 15px; user-select: none; }
        .select-box { padding: 12px; border-radius: 6px; border: 1px solid #333; background: #2a2a2a; color: #fff; font-size: 14px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
        .select-box::after { content: "▼"; font-size: 10px; color: #aaa; }
        .options-container { position: absolute; top: 100%; left: 0; right: 0; background: #2a2a2a; border: 1px solid #333; border-radius: 6px; max-height: 200px; overflow-y: auto; z-index: 100; display: none; flex-direction: column; margin-top: 4px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
        .options-container.show { display: flex; }
        .options-container label { padding: 10px 12px; margin: 0; cursor: pointer; display: flex; align-items: center; border-bottom: 1px solid #333; color: #fff; font-size: 14px; font-weight: 400; }
        .options-container label:last-child { border-bottom: none; }
        .options-container label:hover { background: #333; }
        .options-container input { margin-right: 10px; width: 16px; height: 16px; accent-color: #8b0000; cursor: pointer; }
        .tooltip { position: relative; display: inline-flex; justify-content: center; align-items: center; background: #444; color: #ddd; border-radius: 50%; width: 16px; height: 16px; font-size: 12px; font-weight: bold; margin-left: 6px; cursor: help; }
        .tooltip .tooltiptext { visibility: hidden; width: 220px; background-color: #333; color: #fff; text-align: center; border-radius: 6px; padding: 8px; position: absolute; z-index: 10; bottom: 100%; left: -20px; margin-bottom: 10px; opacity: 0; transition: opacity 0.2s; font-size: 12px; font-weight: 400; box-shadow: 0 4px 10px rgba(0,0,0,0.5); pointer-events: none; line-height: 1.4; }
        .tooltip .tooltiptext::after { content: ""; position: absolute; top: 100%; left: 28px; margin-left: -5px; border-width: 5px; border-style: solid; border-color: #333 transparent transparent transparent; }
        .tooltip:hover .tooltiptext { visibility: visible; opacity: 1; }
        .sub-option-label { display: block; margin: 14px 0 8px; font-weight: 600; font-size: 14px; color: #b3b3b3; }
        .top10-toggle { display: inline-flex; align-items: center; gap: 6px; color: #b3b3b3; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .top10-toggle input { width: 14px; height: 14px; margin: 0; accent-color: #8b0000; cursor: pointer; }
        .sub-options { display: grid; gap: 8px; margin-bottom: 20px; }
        .sub-options .checkbox-group { margin-bottom: 0; padding-left: 18px; }
        .ranked-row { justify-content: space-between; gap: 12px; }
        .ranked-main { display: inline-flex; align-items: center; min-width: 0; color: #fff; cursor: pointer; }
        .ranked-main input { width: 18px; height: 18px; margin: 0 12px 0 0; accent-color: #8b0000; cursor: pointer; }
        .ranked-row .top10-toggle { margin-left: auto; }
        .ranked-row .top10-toggle span { color: #b3b3b3; font-size: 12px; font-weight: 600; }
        @media (max-width: 768px) {
            body { padding: 10px; height: auto; overflow: auto; }
            .wrapper { flex-direction: column; height: auto; }
            .container, .preview-container { flex: none; width: 100%; max-width: 100%; min-width: 0; height: auto; max-height: none; overflow-y: visible; padding: 20px; }
            .item-card.portrait { width: 120px; }
            .item-card.portrait img { width: 120px; }
        }
    </style>
</head>
<body>
    <div class="wrapper">
        <div class="container">
            <h2>Coming Soon</h2>

            <div class="form-group">
                <h3 style="color: #e0e0e0; margin: 0 0 15px 0; font-size: 16px; border-bottom: 1px solid #333; padding-bottom: 8px;">Catalog Filters</h3>
                <label>Add Public Catalog</label>
                <div class="trakt-add-row">
                    <input type="text" id="traktCatalogInput" placeholder="Public Trakt/TMDB list URL, TMDB list ID, or username/list-slug">
                    <div class="trakt-add-buttons">
                        <button type="button" data-catalog-target="auto">Auto</button>
                        <button type="button" data-catalog-target="series">Shows</button>
                        <button type="button" data-catalog-target="movie">Movies</button>
                        <button type="button" data-catalog-target="theaters">Theaters</button>
                    </div>
                </div>
                <div class="trakt-slot">
                    <label>Shows Catalog <button type="button" class="trakt-clear" data-clear-target="series">Clear</button></label>
                    <input type="text" id="traktShowsCatalog" placeholder="No shows catalog selected" oninput="updateLink()">
                    <input type="text" id="showsDisplayName" placeholder="Display name: Coming Soon Shows" oninput="updateLink()">
                </div>
                <div class="trakt-slot">
                    <label>Movies Catalog <button type="button" class="trakt-clear" data-clear-target="movie">Clear</button></label>
                    <input type="text" id="traktMoviesCatalog" placeholder="No movies catalog selected" oninput="updateLink()">
                    <input type="text" id="moviesDisplayName" placeholder="Display name: Coming Soon Movies" oninput="updateLink()">
                </div>
                <div class="trakt-slot">
                    <label>In Theaters Catalog <button type="button" class="trakt-clear" data-clear-target="theaters">Clear</button></label>
                    <input type="text" id="traktTheatersCatalog" placeholder="No in-theaters catalog selected" oninput="updateLink()">
                    <input type="text" id="theatersDisplayName" placeholder="Display name: In Theaters" oninput="updateLink()">
                </div>
                <label>Language</label>
                <div class="multi-select" id="listLangSelect">
                    <div class="select-box" onclick="toggleMultiSelect()">English</div>
                    <div class="options-container" id="listLangOptions">
                        <label><input type="checkbox" value="all" onchange="handleLangChange(this)"> All</label>
                        <label><input type="checkbox" value="en" checked onchange="handleLangChange(this)"> English</label>
                        <label><input type="checkbox" value="non-en" onchange="handleLangChange(this)"> Global (non English)</label>
                        <label><input type="checkbox" value="ja" onchange="handleLangChange(this)"> Japanese</label>
                        <label><input type="checkbox" value="ko" onchange="handleLangChange(this)"> Korean</label>
                        <label><input type="checkbox" value="es" onchange="handleLangChange(this)"> Spanish</label>
                        <label><input type="checkbox" value="fr" onchange="handleLangChange(this)"> French</label>
                        <label><input type="checkbox" value="de" onchange="handleLangChange(this)"> German</label>
                        <label><input type="checkbox" value="hi" onchange="handleLangChange(this)"> Hindi</label>
                    </div>
                </div>
                <label class="checkbox-group" for="digitalOnly"><input type="checkbox" id="digitalOnly" onchange="updateLink()"><span>Filter Movies Not Released Digitally</span></label>
            </div>
            
            <div class="form-group">
                <h3 style="color: #e0e0e0; margin: 0 0 15px 0; font-size: 16px; border-bottom: 1px solid #333; padding-bottom: 8px;">Poster Config</h3>
                <label class="checkbox-group" for="tmdbTrendingToday"><input type="checkbox" id="tmdbTrendingToday" onchange="updateLink()"><span>TMDB Top 10 Trending Today</span></label>
                <label class="checkbox-group" for="portraitTags"><input type="checkbox" id="portraitTags" checked onchange="updateLink()"><span>Tags</span></label>
                <span class="sub-option-label">Streaming Logos</span>
                <div class="sub-options">
                    <label class="checkbox-group" for="portraitMovieLogos"><input type="checkbox" id="portraitMovieLogos" onchange="updateLink()"><span>Movies</span></label>
                    <label class="checkbox-group" for="portraitSeriesLogos"><input type="checkbox" id="portraitSeriesLogos" onchange="updateLink()"><span>TV Shows</span></label>
                    <label class="checkbox-group" for="portraitTheatersLogos"><input type="checkbox" id="portraitTheatersLogos" onchange="updateLink()"><span>In Theaters</span></label>
                </div>
                <span class="sub-option-label">Ranked Logo</span>
                <div class="sub-options">
                    <div class="checkbox-group ranked-row">
                        <label class="ranked-main" for="portraitMovieRanked"><input type="checkbox" id="portraitMovieRanked" onchange="updateLink()"><span>Movies</span></label>
                        <label class="top10-toggle" for="movieTop10Only"><input type="checkbox" id="movieTop10Only" onchange="updateLink()"><span>Top 10 only</span></label>
                    </div>
                    <div class="checkbox-group ranked-row">
                        <label class="ranked-main" for="portraitSeriesRanked"><input type="checkbox" id="portraitSeriesRanked" onchange="updateLink()"><span>TV Shows</span></label>
                        <label class="top10-toggle" for="seriesTop10Only"><input type="checkbox" id="seriesTop10Only" onchange="updateLink()"><span>Top 10 only</span></label>
                    </div>
                    <label class="checkbox-group" for="portraitTheatersRanked"><input type="checkbox" id="portraitTheatersRanked" onchange="updateLink()"><span>In Theaters</span></label>
                </div>
                <label>Poster Language <span class="tooltip">?<span class="tooltiptext">If unavailable, falls back to media source language.</span></span></label>
                <select id="posterLang" onchange="updateLink()"><option value="en" selected>English</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="hi">Hindi</option><option value="null">Textless</option></select>
            </div>
            
            <div style="margin-top: auto;">
                <div class="form-group">
                    <label>Manifest URL</label>
                    <div class="link-container">
                        <input type="text" id="manifestUrl" readonly>
                        <button id="copyBtn" onclick="copyLink()">Copy</button>
                    </div>
                </div>
                <button id="installBtn" class="main-btn">Install</button>
            </div>
        </div>
        
        <div class="preview-container">
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 25px;">
                <h2 style="margin: 0;">Catalog Preview</h2>
            </div>
            <div class="preview-section">
                <h3 class="row-title" id="shows-title">Coming Soon Shows</h3>
                <div id="shows-preview" class="horizontal-scroll"><div class="loading">Add a shows catalog to preview shows</div></div>
            </div>
            <div class="preview-section" style="margin-top: 20px;">
                <h3 class="row-title" id="movies-title">Coming Soon Movies</h3>
                <div id="movies-preview" class="horizontal-scroll"><div class="loading">Add a movies catalog to preview movies</div></div>
            </div>
            <div class="preview-section" style="margin-top: 20px;">
                <h3 class="row-title" id="theaters-title">In Theaters</h3>
                <div id="theaters-preview" class="horizontal-scroll"><div class="loading">Add an in-theaters catalog to preview theatrical releases</div></div>
            </div>
        </div>
    </div>
    <script>
        let previewTimeout;
        let currentShows = [];
        let currentMovies = [];
        let currentTheaters = [];

        function trimAt(input) {
            const value = (input || '').trim();
            return value.charAt(0) === '@' ? value.slice(1) : value;
        }

        function tmdbHost(hostname) {
            const host = (hostname || '').toLowerCase();
            return host === 'themoviedb.org' || host.slice(-16) === '.themoviedb.org';
        }

        function firstDigitPart(value) {
            const text = String(value || '');
            let out = '';
            for (let i = 0; i < text.length; i += 1) {
                const char = text.charAt(i);
                if (char < '0' || char > '9') break;
                out += char;
            }
            return out;
        }

        function tmdbIdPartFromRaw(raw) {
            const lower = raw.toLowerCase();
            let candidate = raw;
            if (lower.indexOf('tmdb:') === 0) candidate = raw.slice(5);
            else if (lower.indexOf('tmdb/list/') === 0) candidate = raw.slice(10);
            else if (lower.indexOf('tmdb/') === 0) candidate = raw.slice(5);
            else if (lower.indexOf('list/') === 0) candidate = raw.slice(5);

            return firstDigitPart(candidate) ? candidate : '';
        }

        function textTokens(value) {
            return String(value || '')
                .toLowerCase()
                .split('-').join(' ')
                .split('_').join(' ')
                .split(' ')
                .filter(Boolean);
        }

        function plainTitle(name) {
            return textTokens(name)
                .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(' ');
        }

        function traktCatalogDisplayName(input) {
            const raw = trimAt(input);
            if (!raw) return '';

            let pathname = raw;
            let isTmdb = false;
            try {
                const parsed = new URL(raw);
                pathname = parsed.pathname;
                isTmdb = tmdbHost(parsed.hostname);
            } catch {
                pathname = raw.startsWith('/') ? raw : '/' + raw;
                const lower = raw.toLowerCase();
                isTmdb = lower.indexOf('tmdb:') === 0
                    || lower.indexOf('tmdb/') === 0
                    || lower.indexOf('list/') === 0
                    || !!firstDigitPart(raw);
            }

            const parts = pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
            let name = '';
            if (isTmdb) {
                const listIndex = parts.findIndex(part => part.toLowerCase() === 'list');
                const fromPath = parts.find(part => !!firstDigitPart(part));
                const idPart = listIndex >= 0 ? parts[listIndex + 1] : (fromPath || tmdbIdPartFromRaw(raw));
                const digitPrefix = firstDigitPart(idPart);
                let slugPart = digitPrefix ? idPart.slice(digitPrefix.length) : '';
                if (slugPart.charAt(0) === '-' || slugPart.charAt(0) === '_') slugPart = slugPart.slice(1);
                name = slugPart || (digitPrefix ? 'TMDB List ' + digitPrefix : '');
            } else if (parts[0] === 'users' && parts[1]) {
                if (parts[2] === 'lists' && parts[3]) name = parts[3];
                else if (parts[2]) name = parts[2];
            } else if (parts.length === 2) {
                name = parts[1];
            } else if (parts.length === 3 && parts[1] === 'lists') {
                name = parts[2];
            }

            return plainTitle(name);
        }

        function traktCatalogTarget(input) {
            const raw = trimAt(input);
            let pathname = raw;
            try {
                pathname = new URL(raw).pathname;
            } catch {
                pathname = raw.startsWith('/') ? raw : '/' + raw;
            }

            const rawTokens = [];
            pathname.split('/').filter(Boolean).forEach(part => {
                textTokens(decodeURIComponent(part)).forEach(token => {
                    rawTokens.push(token);
                });
            });
            const words = traktCatalogDisplayName(input).toLowerCase().split(' ').filter(Boolean);
            const tokens = rawTokens.concat(words);
            const lastWord = tokens[tokens.length - 1] || '';

            if (tokens.some(word => ['theater', 'theaters', 'theatre', 'theatres', 'cinema', 'cinemas'].includes(word))) return 'theaters';
            if (tokens.some(word => ['show', 'shows', 'series'].includes(word)) || ['show', 'shows', 'series'].includes(lastWord)) return 'series';
            if (tokens.some(word => ['movie', 'movies', 'film', 'films'].includes(word)) || ['movie', 'movies', 'film', 'films'].includes(lastWord)) return 'movie';
            if (tmdbIdPartFromRaw(raw)) return 'movie';
            if (raw.toLowerCase().indexOf('themoviedb.org') >= 0) return 'movie';

            return 'movie';
        }

        function assignTraktCatalog(target) {
            const input = document.getElementById('traktCatalogInput');
            const value = input.value.trim();
            if (!value) return;

            let resolvedTarget = target;
            if (target === 'auto') {
                try {
                    resolvedTarget = traktCatalogTarget(value);
                } catch {
                    resolvedTarget = 'movie';
                }
            }
            if (resolvedTarget === 'series') {
                document.getElementById('traktShowsCatalog').value = value;
            } else if (resolvedTarget === 'movie') {
                document.getElementById('traktMoviesCatalog').value = value;
            } else if (resolvedTarget === 'theaters') {
                document.getElementById('traktTheatersCatalog').value = value;
            } else {
                document.getElementById('traktMoviesCatalog').value = value;
            }

            input.value = '';
            updateLink();
        }

        function clearTraktCatalog(target) {
            const fieldId = target === 'series' ? 'traktShowsCatalog' : target === 'theaters' ? 'traktTheatersCatalog' : 'traktMoviesCatalog';
            document.getElementById(fieldId).value = '';
            updateLink();
        }

        function bindCatalogButtons() {
            document.querySelectorAll('[data-catalog-target]').forEach(button => {
                button.addEventListener('click', function() {
                    assignTraktCatalog(this.getAttribute('data-catalog-target'));
                });
            });

            document.querySelectorAll('[data-clear-target]').forEach(button => {
                button.addEventListener('click', function() {
                    clearTraktCatalog(this.getAttribute('data-clear-target'));
                });
            });
        }

        function updatePreviewTitles(showsCatalog, moviesCatalog, theatersCatalog, tmdbTrending, showsDisplayName, moviesDisplayName, theatersDisplayName) {
            document.getElementById('shows-title').textContent = showsDisplayName || traktCatalogDisplayName(showsCatalog) || (tmdbTrending ? 'TMDB Top 10 Trending Shows Today' : 'Coming Soon Shows');
            document.getElementById('movies-title').textContent = moviesDisplayName || traktCatalogDisplayName(moviesCatalog) || (tmdbTrending ? 'TMDB Top 10 Trending Streaming Movies Today' : 'Coming Soon Movies');
            document.getElementById('theaters-title').textContent = theatersDisplayName || traktCatalogDisplayName(theatersCatalog) || 'In Theaters';
        }

        function toggleMultiSelect() {
            document.getElementById('listLangOptions').classList.toggle('show');
        }

        document.addEventListener('click', function(e) {
            if (!e.target.closest('.multi-select')) {
                const opts = document.getElementById('listLangOptions');
                if (opts) opts.classList.remove('show');
            }
        });

        function handleLangChange(cb) {
            if ((cb.value === 'all' || cb.value === 'non-en') && cb.checked) {
                document.querySelectorAll('#listLangOptions input').forEach(input => {
                    if (input !== cb) input.checked = false;
                });
            } else if (cb.checked) {
                const allCb = document.querySelector('#listLangOptions input[value="all"]');
                if (allCb) allCb.checked = false;
                const nonEnCb = document.querySelector('#listLangOptions input[value="non-en"]');
                if (nonEnCb) nonEnCb.checked = false;
            }
            updateLink();
        }

        function updateLink() {
            const pt = document.getElementById('portraitTags').checked,
                  tmdbTrending = document.getElementById('tmdbTrendingToday').checked,
                  pmlo = document.getElementById('portraitMovieLogos').checked,
                  pslo = document.getElementById('portraitSeriesLogos').checked,
                  ptlo = document.getElementById('portraitTheatersLogos').checked,
                  pmranked = document.getElementById('portraitMovieRanked').checked,
                  psranked = document.getElementById('portraitSeriesRanked').checked,
                  ptranked = document.getElementById('portraitTheatersRanked').checked,
                  movieTop10 = document.getElementById('movieTop10Only').checked,
                  seriesTop10 = document.getElementById('seriesTop10Only').checked,
                  plang = document.getElementById('posterLang').value,
                  d = document.getElementById('digitalOnly').checked,
                  traktShows = document.getElementById('traktShowsCatalog').value.trim(),
                  traktMovies = document.getElementById('traktMoviesCatalog').value.trim(),
                  traktTheaters = document.getElementById('traktTheatersCatalog').value.trim(),
                  showsDisplayName = document.getElementById('showsDisplayName').value.trim(),
                  moviesDisplayName = document.getElementById('moviesDisplayName').value.trim(),
                  theatersDisplayName = document.getElementById('theatersDisplayName').value.trim();

            updatePreviewTitles(traktShows, traktMovies, traktTheaters, tmdbTrending, showsDisplayName, moviesDisplayName, theatersDisplayName);
                  
            const checkedLangs = Array.from(document.querySelectorAll('#listLangOptions input:checked'));
            const l = checkedLangs.map(opt => opt.value).join(',') || 'all';
            
            const box = document.querySelector('.select-box');
            if (checkedLangs.length === 0) box.textContent = 'All';
            else if (checkedLangs.length <= 2) box.textContent = checkedLangs.map(cb => cb.parentElement.textContent.trim()).join(', ');
            else box.textContent = checkedLangs.length + ' Languages Selected';
                  
            const traktShowsPart = traktShows ? "|traktShowsCatalog=" + encodeURIComponent(traktShows) : "";
            const traktMoviesPart = traktMovies ? "|traktMoviesCatalog=" + encodeURIComponent(traktMovies) : "";
            const traktTheatersPart = traktTheaters ? "|traktTheatersCatalog=" + encodeURIComponent(traktTheaters) : "";
            const showsDisplayNamePart = showsDisplayName ? "|showsDisplayName=" + encodeURIComponent(showsDisplayName) : "";
            const moviesDisplayNamePart = moviesDisplayName ? "|moviesDisplayName=" + encodeURIComponent(moviesDisplayName) : "";
            const theatersDisplayNamePart = theatersDisplayName ? "|theatersDisplayName=" + encodeURIComponent(theatersDisplayName) : "";
            const anyPortraitLogos = pmlo || pslo || ptlo;
            const anyPortraitRanked = pmranked || psranked || ptranked;
            const c = "landscapeTags=false|landscapeLogos=false|landscapeRanked=false|portraitTags=" + pt + "|tmdbTrendingToday=" + tmdbTrending + "|portraitLogos=" + anyPortraitLogos + "|portraitMovieLogos=" + pmlo + "|portraitSeriesLogos=" + pslo + "|portraitTheatersLogos=" + ptlo + "|portraitRanked=" + anyPortraitRanked + "|portraitMovieRanked=" + pmranked + "|portraitSeriesRanked=" + psranked + "|portraitTheatersRanked=" + ptranked + "|movieTop10Only=" + movieTop10 + "|seriesTop10Only=" + seriesTop10 + "|posterLang=" + plang + "|digitalOnly=" + d + "|listLang=" + l + traktShowsPart + traktMoviesPart + traktTheatersPart + showsDisplayNamePart + moviesDisplayNamePart + theatersDisplayNamePart;
            const h = window.location.host, pr = window.location.protocol;
            
            document.getElementById('manifestUrl').value = pr + "//" + h + "/" + c + "/manifest.json";
            document.getElementById('installBtn').onclick = () => { window.location.href = "stremio://" + h + "/" + c + "/manifest.json" };
            
            clearTimeout(previewTimeout);
            previewTimeout = setTimeout(() => updatePreviews(c, pr, h), 500);
        }
        
        async function updatePreviews(config, pr, h) {
            const showsContainer = document.getElementById('shows-preview');
            const moviesContainer = document.getElementById('movies-preview');
            const theatersContainer = document.getElementById('theaters-preview');
            const traktShows = document.getElementById('traktShowsCatalog').value.trim();
            const traktMovies = document.getElementById('traktMoviesCatalog').value.trim();
            const traktTheaters = document.getElementById('traktTheatersCatalog').value.trim();
            const tmdbTrending = document.getElementById('tmdbTrendingToday').checked;
            const loadShows = !!traktShows || tmdbTrending;
            const loadMovies = !!traktMovies || tmdbTrending;

            if (!loadShows && !loadMovies && !traktTheaters) {
                currentShows = [];
                currentMovies = [];
                currentTheaters = [];
                showsContainer.innerHTML = '<div class="loading">Add a shows catalog to preview shows</div>';
                moviesContainer.innerHTML = '<div class="loading">Add a movies catalog to preview movies</div>';
                theatersContainer.innerHTML = '<div class="loading">Add an in-theaters catalog to preview theatrical releases</div>';
                return;
            }

            showsContainer.innerHTML = loadShows ? '<div class="loading">Loading shows...</div>' : '<div class="loading">Add a shows catalog to preview shows</div>';
            moviesContainer.innerHTML = loadMovies ? '<div class="loading">Loading movies...</div>' : '<div class="loading">Add a movies catalog to preview movies</div>';
            theatersContainer.innerHTML = traktTheaters ? '<div class="loading">Loading theatrical releases...</div>' : '<div class="loading">Add an in-theaters catalog to preview theatrical releases</div>';
            
            try {
                const [showsRes, moviesRes, theatersRes] = await Promise.all([
                    loadShows ? fetch(pr + "//" + h + "/" + config + "/catalog/series/calendar_lite_shows.json") : Promise.resolve(null),
                    loadMovies ? fetch(pr + "//" + h + "/" + config + "/catalog/movie/calendar_lite_movies.json") : Promise.resolve(null),
                    traktTheaters ? fetch(pr + "//" + h + "/" + config + "/catalog/movie/calendar_lite_theaters.json") : Promise.resolve(null)
                ]);
                
                const showsData = showsRes ? await showsRes.json() : { metas: [] };
                const moviesData = moviesRes ? await moviesRes.json() : { metas: [] };
                const theatersData = theatersRes ? await theatersRes.json() : { metas: [] };

                if (showsRes && (!showsRes.ok || showsData.err)) throw new Error(showsData.err || 'Shows catalog failed');
                if (moviesRes && (!moviesRes.ok || moviesData.err)) throw new Error(moviesData.err || 'Movies catalog failed');
                if (theatersRes && (!theatersRes.ok || theatersData.err)) throw new Error(theatersData.err || 'In Theaters catalog failed');
                
                currentShows = showsData.metas || [];
                currentMovies = moviesData.metas || [];
                currentTheaters = theatersData.metas || [];
                
                renderCurrentData();
                if (!loadShows) showsContainer.innerHTML = '<div class="loading">Add a shows catalog to preview shows</div>';
                if (!loadMovies) moviesContainer.innerHTML = '<div class="loading">Add a movies catalog to preview movies</div>';
                if (!traktTheaters) theatersContainer.innerHTML = '<div class="loading">Add an in-theaters catalog to preview theatrical releases</div>';
                
            } catch (err) {
                const message = err && err.message ? err.message : 'Error loading preview';
                if (loadShows) showsContainer.innerHTML = '<div class="loading">' + message + '</div>';
                if (loadMovies) moviesContainer.innerHTML = '<div class="loading">' + message + '</div>';
                if (traktTheaters) theatersContainer.innerHTML = '<div class="loading">' + message + '</div>';
            }
        }
        
        function renderCurrentData() {
            const showsContainer = document.getElementById('shows-preview');
            const moviesContainer = document.getElementById('movies-preview');
            const theatersContainer = document.getElementById('theaters-preview');
            
            const renderItems = (items) => {
                if (!items || items.length === 0) return '<div class="loading">No items found</div>';
                return items.map(item => {
                    const tmdbId = item._tmdbId || item.id.replace('tmdb:', '').replace('tt', '');
                    const tmdbType = item.type === 'series' ? 'tv' : 'movie';
                    return '<a href="https://www.themoviedb.org/' + tmdbType + '/' + tmdbId + '" target="_blank" class="item-card portrait">' +
                           '<img src="' + item.poster + '" alt="poster" loading="lazy" />' + 
                           '<p class="item-title" title="' + item.name + '">' + item.name + '</p>' + 
                           '</a>';
                }).join('');
            };
            
            showsContainer.innerHTML = renderItems(currentShows);
            moviesContainer.innerHTML = renderItems(currentMovies);
            theatersContainer.innerHTML = renderItems(currentTheaters);
        }
        
        function copyLink() {
            const c = document.getElementById("manifestUrl");
            c.select();
            c.setSelectionRange(0, 99999);
            navigator.clipboard.writeText(c.value).then(() => {
                const b = document.getElementById("copyBtn");
                const o = b.innerText;
                b.innerText = "Copied!";
                b.style.backgroundColor = "#660000";
                setTimeout(() => { b.innerText = o; b.style.backgroundColor = "#8b0000" }, 2000);
            });
        }
        bindCatalogButtons();
        updateLink();
    </script>
</body>
</html>`;

// ─── Route plumbing (unchanged) ───────────────────────────────────────────────

const parseConfig = (configStr) => {
    const configObj = {};
    if (configStr) {
        configStr.split('|').forEach(pair => {
            const [key, val] = pair.split('=');
            if (key && val) configObj[key] = decodeURIComponent(val);
        });
    }
    return configObj;
};

const addonInterface = builder.getInterface();

const configWithRequestBaseUrl = (req, config = {}) => ({
    ...config,
    addonUrl: requestBaseUrl(req)
});

const sendCatalogError = (res, error) => {
    console.error("Catalog error:", error);
    const message = error?.message?.startsWith("Unsupported catalog.")
        ? error.message
        : "Catalog fetch failed. Check that the catalog URL is a public Trakt or TMDB list and try again.";
    res.status(500).json({ err: message });
};

app.get('/', (req, res) => res.send(configUI));
app.get('/configure', (req, res) => res.send(configUI));
app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));
app.get('/:config/manifest.json', (req, res) => {
    const config = parseConfig(req.params.config);
    const configuredManifest = JSON.parse(JSON.stringify(addonInterface.manifest));
    if (configuredManifest.behaviorHints) configuredManifest.behaviorHints.configurationRequired = false;
    configuredManifest.catalogs = configuredCatalogs(config);
    res.json(configuredManifest);
});

app.get('/catalog/:type/:id.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: configWithRequestBaseUrl(req) }));
    } catch (error) { sendCatalogError(res, error); }
});

app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: configWithRequestBaseUrl(req) }));
    } catch (error) { sendCatalogError(res, error); }
});

app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: configWithRequestBaseUrl(req, parseConfig(req.params.config)) }));
    } catch (error) { sendCatalogError(res, error); }
});

app.get('/:config/catalog/:type/:id/:extra.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: configWithRequestBaseUrl(req, parseConfig(req.params.config)) }));
    } catch (error) { sendCatalogError(res, error); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon active on port ${PORT}`));
