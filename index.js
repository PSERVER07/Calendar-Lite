const express = require("express");
const { addonBuilder } = require("stremio-addon-sdk");
const sharp = require("sharp");

const app = express();
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const ADDON_URL = process.env.ADDON_URL;

// Fetch and cache TMDB genres on startup
let genreMap = {};
async function fetchGenres() {
    try {
        const [movieRes, tvRes] = await Promise.all([
            fetch(`https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}`).then(r => r.json()),
            fetch(`https://api.themoviedb.org/3/genre/tv/list?api_key=${TMDB_API_KEY}`).then(r => r.json())
        ]);
        if (movieRes.genres) movieRes.genres.forEach(g => genreMap[g.id] = g.name);
        if (tvRes.genres) tvRes.genres.forEach(g => genreMap[g.id] = g.name);
        console.log("Genres loaded successfully!");
    } catch (error) { console.error("Failed to fetch genres:", error); }
}
fetchGenres();

const manifest = {
    id: "com.trending.custom",
    version: "1.10.29", // Shifted color/luminance sampling to the bottom 50% of the image
    name: "TMDB Trending Today",
    description: "Customizable Stremio catalogs for top trending TMDB content with optional graphic tags and ranked posters.",
    behaviorHints: { configurable: true, configurationRequired: true },
    resources: ["catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tmdb:"],
    catalogs: [
        { id: "top_movies_today", type: "movie", name: "Top Movies Today" },
        { id: "top_shows_today", type: "series", name: "Top Shows Today" }
    ]
};

const builder = new addonBuilder(manifest);

const diffDays = (date1, date2) => {
    const d1 = new Date(date1); d1.setUTCHours(0, 0, 0, 0);
    const d2 = new Date(date2); d2.setUTCHours(0, 0, 0, 0);
    return Math.round(Math.abs(d1 - d2) / (1000 * 60 * 60 * 24));
};

const formatFutureDate = (dateObj) => {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${monthNames[dateObj.getUTCMonth()]} ${dateObj.getUTCDate()}`;
};

const tagDisplayNameMap = {
    "just_added": "Just Added",
    "coming_soon": "Coming Soon",
    "new_movie": "New Movie",
    "premiere": "Premiere",
    "new_series": "New Series",
    "season_finale": "Season Finale",
    "final_season": "Final Season",
    "new_season": "New Season",
    "new_episode": "New Episode"
};

builder.defineCatalogHandler(async (args) => {
    const { type, id, extra } = args;
    const config = extra?.config || {};

    const userConfig = {
        tags: config.tags !== "false",
        ranked: config.ranked !== "false",
        digitalOnly: config.digitalOnly !== "false",
        listLang: config.listLang || "en",
        posterLang: config.posterLang || "en"
    };

    const tmdbType = type === 'series' ? 'tv' : 'movie';
    let finalItems = [];
    let seenIds = new Set();
    let page = 1;
    const maxPages = 10;
    const TODAY = new Date();

    while (finalItems.length < 10 && page <= maxPages) {
        const response = await fetch(`https://api.themoviedb.org/3/trending/${tmdbType}/day?api_key=${TMDB_API_KEY}&page=${page}`);
        const data = await response.json();
        if (!data.results || data.results.length === 0) break;

        let pageItems = data.results.filter(item => {
            if (userConfig.listLang === 'non-en' && item.original_language === 'en') return false;
            if (userConfig.listLang !== 'all' && userConfig.listLang !== 'non-en' && item.original_language !== userConfig.listLang) return false;
            if (seenIds.has(item.id)) return false;
            seenIds.add(item.id);
            return true;
        });

        if (type === 'movie' && pageItems.length > 0) {
            const releaseDatesData = await Promise.all(pageItems.map(async (movie) => {
                try {
                    const releaseRes = await fetch(`https://api.themoviedb.org/3/movie/${movie.id}/release_dates?api_key=${TMDB_API_KEY}`);
                    const releaseData = await releaseRes.json();
                    let earliestDigital = null;

                    if (releaseData.results) {
                        for (const country of releaseData.results) {
                            for (const release of country.release_dates) {
                                if (release.type === 4 || release.type === 5) {
                                    const relDate = new Date(release.release_date);
                                    if (!earliestDigital || relDate < earliestDigital) earliestDigital = relDate;
                                }
                            }
                        }
                    }
                    return earliestDigital;
                } catch (err) { return null; }
            }));

            pageItems.forEach((item, index) => item._earliestDigital = releaseDatesData[index]);

            if (userConfig.digitalOnly) {
                pageItems = pageItems.filter(item => item._earliestDigital && item._earliestDigital <= TODAY);
            }

            pageItems.forEach(item => {
                if (userConfig.tags) {
                    if (!item._earliestDigital || item._earliestDigital > TODAY) {
                        if (item._earliestDigital) {
                            const daysUntil = diffDays(item._earliestDigital, TODAY);
                            if (daysUntil <= 14) {
                                const formattedDate = formatFutureDate(item._earliestDigital);
                                item._tag = `coming_date_${formattedDate.replace(' ', '_')}`;
                            } else {
                                item._tag = "coming_soon";
                            }
                        } else {
                            item._tag = "coming_soon";
                        }
                    } else {
                        const daysSince = diffDays(TODAY, item._earliestDigital);
                        if (daysSince <= 7) item._tag = "just_added";
                        else if (daysSince <= 30) item._tag = "new_movie";
                    }
                } else {
                    item._tag = "none";
                }
            });

        } else if (type === 'series' && pageItems.length > 0) {
            if (userConfig.tags) {
                const tvDetailsData = await Promise.all(pageItems.map(async (show) => {
                    try {
                        const res = await fetch(`https://api.themoviedb.org/3/tv/${show.id}?api_key=${TMDB_API_KEY}`);
                        return await res.json();
                    } catch (err) { return null; }
                }));

                pageItems.forEach((item, index) => {
                    const tvData = tvDetailsData[index];
                    if (!tvData) return;

                    let lastEp = tvData.last_episode_to_air;
                    let nextEp = tvData.next_episode_to_air;

                    if (nextEp && nextEp.air_date) {
                        const nextAirDate = new Date(nextEp.air_date);
                        if (nextAirDate <= TODAY) {
                            lastEp = nextEp;
                            nextEp = null;
                        }
                    }

                    let isFinale = false;
                    if (lastEp) {
                        const currentSeason = tvData.seasons?.find(s => s.season_number === lastEp.season_number);
                        const expectedCount = currentSeason?.episode_count || 0;

                        if (lastEp.episode_type) {
                            isFinale = (lastEp.episode_type === "finale");
                        } else {
                            if (expectedCount > 0 && lastEp.episode_number >= expectedCount) {
                                isFinale = true;
                            } else if (!nextEp && lastEp.episode_number > 1) {
                                if (expectedCount === 0 || lastEp.episode_number >= expectedCount) {
                                    isFinale = true;
                                }
                            }
                        }
                    }

                    const firstAir = tvData.first_air_date ? new Date(tvData.first_air_date) : null;
                    const lastAir = lastEp && lastEp.air_date ? new Date(lastEp.air_date) : (tvData.last_air_date ? new Date(tvData.last_air_date) : null);

                    let itemTag = null;
                    let futureDate = null;
                    let isBrandNewSeries = false;

                    if (firstAir && firstAir > TODAY) {
                        futureDate = firstAir;
                        isBrandNewSeries = true;
                    } else if (nextEp && nextEp.episode_number === 1) {
                        futureDate = new Date(nextEp.air_date);
                    }

                    if (futureDate) {
                        const daysUntil = diffDays(futureDate, TODAY);
                        if (daysUntil <= 14) {
                            const formattedDate = formatFutureDate(futureDate);
                            itemTag = `coming_date_${formattedDate.replace(' ', '_')}`;
                        } else if (isBrandNewSeries) {
                            itemTag = "coming_soon";
                        }
                    }

                    if (!itemTag) {
                        if (nextEp && nextEp.air_date) {
                            const nextAirDate = new Date(nextEp.air_date);
                            if (nextAirDate > TODAY && diffDays(nextAirDate, TODAY) <= 5) {
                                let isNextFinale = false;
                                const nextSeason = tvData.seasons?.find(s => s.season_number === nextEp.season_number);
                                const expectedCount = nextSeason?.episode_count || 0;

                                if (nextEp.episode_type) {
                                    isNextFinale = (nextEp.episode_type === "finale");
                                } else {
                                    if (expectedCount > 0 && nextEp.episode_number >= expectedCount) {
                                        isNextFinale = true;
                                    }
                                }

                                if (isNextFinale) {
                                    const formattedDate = formatFutureDate(nextAirDate);
                                    itemTag = `finale_date_${formattedDate.replace(' ', '_')}`;
                                }
                            }
                        }
                    }

                    if (!itemTag) {
                        if (firstAir && firstAir <= TODAY && diffDays(TODAY, firstAir) <= 7) {
                            itemTag = "premiere";
                        } else if (isFinale && lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 7) {
                            itemTag = "season_finale";
                        } else if ((tvData.status === "Ended" || tvData.status === "Canceled") && tvData.number_of_seasons > 1 && lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 30) {
                            itemTag = "final_season";
                        } else if (firstAir && firstAir <= TODAY && diffDays(TODAY, firstAir) <= 14) {
                            itemTag = "new_series";
                        } else {
                            const latestSeason = tvData.seasons?.slice().reverse().find(s => s.season_number > 0);
                            if (latestSeason && latestSeason.air_date) {
                                const seasonAir = new Date(latestSeason.air_date);
                                if (seasonAir <= TODAY && diffDays(TODAY, seasonAir) <= 14) itemTag = "new_season";
                            }
                            if (!itemTag && lastAir && lastAir <= TODAY && diffDays(TODAY, lastAir) <= 7) {
                                itemTag = "new_episode";
                            }
                        }
                    }

                    item._tag = itemTag || "none";
                });
            } else {
                pageItems.forEach(item => item._tag = "none");
            }
        }

        finalItems.push(...pageItems);
        page++;
    }

    const metas = finalItems.map((item, index) => {
        const rank = index + 1;

        let finalPosterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
        if (userConfig.ranked) {
            finalPosterUrl = `${ADDON_URL}/proxy-image-poster/${type}/${item.id}/${rank}/${userConfig.posterLang}.png`;
        }

        let itemGenres = item.genre_ids ? item.genre_ids.map(gId => genreMap[gId]).filter(Boolean) : [];

        if (userConfig.listLang === 'non-en' && item.original_language) {
            try {
                const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(item.original_language);
                if (langName) {
                    itemGenres.unshift(langName);
                }
            } catch (e) {
                itemGenres.unshift(item.original_language.toUpperCase());
            }
        }

        return {
            id: `tmdb:${item.id}`,
            name: item.title || item.name,
            type: type,
            genres: itemGenres,
            description: item.overview || "",
            background: `${ADDON_URL}/proxy-image-backdrop/${type}/${item.id}/${item._tag || 'none'}/${userConfig.posterLang}.png`,
            poster: finalPosterUrl
        };
    });

    return { metas };
});

app.get('/proxy-image-backdrop/:type/:id/:tag/:lang.png', async (req, res) => {
    try {
        const { type, id, tag, lang } = req.params;
        const tmdbType = type === 'series' ? 'tv' : 'movie';

        const response = await fetch(`https://api.themoviedb.org/3/${tmdbType}/${id}/images?api_key=${TMDB_API_KEY}`);
        const details = await response.json();

        const backdropLangToUse = lang === 'null' ? null : lang;

        const backdrop = details.backdrops?.find(b => b.iso_639_1 === backdropLangToUse)
            || details.backdrops?.find(b => b.iso_639_1 === null)
            || details.backdrops?.[0];

        if (!backdrop || !backdrop.file_path) {
            return res.redirect(301, 'https://via.placeholder.com/1280x720.png?text=No+Background+Available');
        }

        let tagText = tagDisplayNameMap[tag];

        if (tag && tag.startsWith('coming_date_')) {
            const dateParts = tag.replace('coming_date_', '').split('_');
            if (dateParts.length === 2) {
                tagText = `Coming ${dateParts[0]} ${dateParts[1]}`;
            }
        } else if (tag && tag.startsWith('finale_date_')) {
            const dateParts = tag.replace('finale_date_', '').split('_');
            if (dateParts.length === 2) {
                tagText = `Finale ${dateParts[0]} ${dateParts[1]}`;
            }
        }

        if (tag === 'none' || !tagText) {
            return res.redirect(301, `https://image.tmdb.org/t/p/w1280${backdrop.file_path}`);
        }

        const backdropResponse = await fetch(`https://image.tmdb.org/t/p/w1280${backdrop.file_path}`);
        const backdropBuffer = Buffer.from(await backdropResponse.arrayBuffer());

        const backdropImage = sharp(backdropBuffer);
        const metadata = await backdropImage.metadata();
        const width = metadata.width;

        const tagHeight = Math.round(metadata.height * 0.15);
        const fontSize = Math.round(tagHeight * 0.75);

        let estimatedTextWidth = 0;
        for (let i = 0; i < tagText.length; i++) {
            const char = tagText[i];
            if ("iIl1., -".includes(char)) {
                estimatedTextWidth += fontSize * 0.25;
            } else if ("rftj".includes(char)) {
                estimatedTextWidth += fontSize * 0.35;
            } else if ("WMwm@".includes(char)) {
                estimatedTextWidth += fontSize * 0.85;
            } else if ("NQDOUCGRHKBAVXY".includes(char)) {
                estimatedTextWidth += fontSize * 0.70;
            } else if ("PESZT".includes(char)) {
                estimatedTextWidth += fontSize * 0.60;
            } else {
                estimatedTextWidth += fontSize * 0.50;
            }
        }

        const horizontalPadding = fontSize * 1.8;
        const tagWidth = Math.round(estimatedTextWidth + horizontalPadding);

        const startX = Math.round((width / 2) - (tagWidth / 2));
        const startY = metadata.height - tagHeight;
        const r = Math.round(tagHeight * 0.25);

        const extractLeft = Math.max(0, startX);
        const extractTop = Math.max(0, startY);
        const extractWidth = Math.min(tagWidth, width - extractLeft);
        const extractHeight = Math.min(tagHeight, metadata.height - extractTop);

        let tagFillColor = "#1a1a1a";
        let textColor = "white";
        let bottomHalfLuminance = 0;

        try {
            // --- NEW: Isolate the bottom 50% of the image for sampling ---
            const bottomHalfTop = Math.floor(metadata.height / 2);
            const bottomHalfHeight = metadata.height - bottomHalfTop;

            const bottomHalfBuffer = await sharp(backdropBuffer)
                .extract({ left: 0, top: bottomHalfTop, width: metadata.width, height: bottomHalfHeight })
                .toBuffer();

            const stats = await sharp(bottomHalfBuffer).stats();

            if (stats.channels.length >= 3) {
                const meanR = Math.round(stats.channels[0].mean);
                const meanG = Math.round(stats.channels[1].mean);
                const meanB = Math.round(stats.channels[2].mean);

                tagFillColor = `rgb(${meanR}, ${meanG}, ${meanB})`;
                bottomHalfLuminance = (0.299 * meanR) + (0.587 * meanG) + (0.114 * meanB);

            } else if (stats.channels.length > 0) {
                const meanVal = Math.round(stats.channels[0].mean);
                tagFillColor = `rgb(${meanVal}, ${meanVal}, ${meanVal})`;
                bottomHalfLuminance = meanVal;
            }

            // Adjusted threshold slightly to account for the larger sample area
            if (bottomHalfLuminance > 140) {
                textColor = "#121212";
            } else {
                textColor = "#ffffff";
            }
        } catch (statsErr) {
            console.error("Thematic bottom-half color extraction failed, using defaults:", statsErr.message);
        }

        const pathD = `
            M ${startX},${metadata.height} 
            L ${startX + tagWidth},${metadata.height} 
            L ${startX + tagWidth},${startY + r}
            Q ${startX + tagWidth},${startY} ${startX + tagWidth - r},${startY}
            L ${startX + r},${startY} 
            Q ${startX},${startY} ${startX},${startY + r} 
            Z
        `;

        let tagFillOpacity = bottomHalfLuminance > 140 ? "0.65" : "0.45";
        let compositeOperations = [];

        try {
            // The physical blur still happens ONLY on the exact localized cutout!
            const blurredRect = await sharp(backdropBuffer)
                .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
                .blur(15)
                .png()
                .toBuffer();

            const localPathD = `
                M 0,${extractHeight} 
                L ${extractWidth},${extractHeight} 
                L ${extractWidth},${r}
                Q ${extractWidth},0 ${extractWidth - r},0
                L ${r},0 
                Q 0,0 0,${r} 
                Z
            `;
            const localMaskSvg = `
            <svg width="${extractWidth}" height="${extractHeight}">
                <path d="${localPathD}" fill="white" />
            </svg>`;

            const shapedBlurredBox = await sharp(blurredRect)
                .composite([{ input: Buffer.from(localMaskSvg), blend: 'dest-in' }])
                .png()
                .toBuffer();

            compositeOperations.push({ input: shapedBlurredBox, top: extractTop, left: extractLeft });
        } catch (blurErr) {
            console.error("Frosted blur pipeline failed:", blurErr.message);
            tagFillOpacity = "0.85";
        }

        const fontStack = "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

        const svgTag = `
        <svg width="${width}" height="${metadata.height}">
            <path d="${pathD}" fill="${tagFillColor}" fill-opacity="${tagFillOpacity}"/>
            <text x="${width / 2}" y="${startY + (tagHeight / 2) + (fontSize * 0.35)}" text-anchor="middle" font-family="${fontStack}" font-size="${fontSize}" fill="${textColor}" font-weight="bold">${tagText}</text>
        </svg>
        `;

        compositeOperations.push({ input: Buffer.from(svgTag), top: 0, left: 0 });

        const finalImageBuffer = await backdropImage
            .composite(compositeOperations)
            .png()
            .toBuffer();

        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "public, max-age=86400");
        res.send(finalImageBuffer);
    } catch (error) {
        console.error("Backdrop generation error:", error);
        res.status(500).send("Error generating image");
    }
});

app.get('/proxy-image-poster/:type/:id/:rank/:lang.png', async (req, res) => {
    try {
        const { type, id, rank, lang } = req.params;
        const tmdbType = type === 'series' ? 'tv' : 'movie';

        const response = await fetch(`https://api.themoviedb.org/3/${tmdbType}/${id}/images?api_key=${TMDB_API_KEY}`);
        const details = await response.json();

        const posterLangToUse = lang === 'null' ? null : lang;

        const poster = details.posters?.find(p => p.iso_639_1 === posterLangToUse)
            || details.posters?.find(p => p.iso_639_1 === null)
            || details.posters?.find(p => p.iso_639_1 === 'en')
            || details.posters?.[0];

        if (!poster || !poster.file_path) {
            return res.redirect(301, 'https://via.placeholder.com/500x750.png?text=Poster+Unavailable');
        }

        const posterResponse = await fetch(`https://image.tmdb.org/t/p/w500${poster.file_path}`);
        const posterBuffer = Buffer.from(await posterResponse.arrayBuffer());

        const posterImage = sharp(posterBuffer);
        const metadata = await posterImage.metadata();
        const width = metadata.width;

        const fontSize = Math.round(width * 0.30);
        const paddingTop = Math.round(width * 0.08);
        const paddingLeft = Math.round(width * 0.08);

        const fontStack = "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

        const fontStyle = `
        <style>
            @font-face {
                font-family: 'SF Pro Display';
                src: local('SF Pro Display Bold'), local('SFProDisplay-Bold');
                font-weight: bold;
                font-style: normal;
            }
        </style>
        `;

        const gradientDef = `
        <defs>
            <linearGradient id="rankGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#ffffff;stop-opacity:1" /> 
                <stop offset="60%" style="stop-color:#c0c0c0;stop-opacity:1" /> 
                <stop offset="100%" style="stop-color:#808080;stop-opacity:1" /> 
            </linearGradient>
            
            <filter id="rankShadow" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3"/> 
                <feOffset dx="3" dy="3" result="offsetblur"/>
                <feFlood flood-color="black" flood-opacity="0.9"/> 
                <feComposite in2="offsetblur" operator="in"/>
                <feMerge>
                    <feMergeNode/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
            
            <radialGradient id="shimmerGradient" cx="0%" cy="0%" r="100%" fx="0%" fy="0%">
                <stop offset="0%" style="stop-color:black;stop-opacity:0.6" /> 
                <stop offset="40%" style="stop-color:black;stop-opacity:0.3" /> 
                <stop offset="100%" style="stop-color:black;stop-opacity:0" /> 
            </radialGradient>
        </defs>
        `;

        const svgTag = `
        <svg width="${width}" height="${metadata.height}">
            ${fontStyle}
            ${gradientDef}
            <rect x="0" y="0" width="${width * 0.6}" height="${fontSize * 2}" fill="url(#shimmerGradient)"/>
            <text x="${paddingLeft}" y="${paddingTop + fontSize / 1.3}" text-anchor="start" font-family="${fontStack}" font-size="${fontSize}" fill="url(#rankGradient)" fill-opacity="0.80" font-weight="bold" filter="url(#rankShadow)">${rank}</text>
        </svg>
        `;

        const finalImageBuffer = await posterImage
            .composite([
                {
                    input: Buffer.from(svgTag),
                    top: 0,
                    left: 0
                }
            ])
            .png()
            .toBuffer();

        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "public, max-age=86400");
        res.send(finalImageBuffer);
    } catch (error) {
        console.error("Poster generation error:", error);
        res.status(500).send("Error generating image");
    }
});

const configUI = `<!DOCTYPE html><html><head><title>TMDB Trending Today</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#121212;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.container{background-color:#1e1e1e;padding:30px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);width:100%;max-width:400px;max-height:95vh;overflow-y:auto}h2{margin-top:0;text-align:center;color:#e0e0e0}.form-group{margin-bottom:20px}label{display:block;margin-bottom:8px;font-weight:600;font-size:14px;color:#b3b3b3}select{width:100%;padding:12px;border-radius:6px;border:1px solid #333;background:#2a2a2a;color:#fff;font-size:14px;outline:none;box-sizing:border-box}select:focus{border-color:#8b0000}.checkbox-group{display:flex;align-items:center;background:#2a2a2a;padding:12px;border-radius:6px;border:1px solid #333;cursor:pointer;margin-bottom:10px}.checkbox-group input{margin-right:12px;width:18px;height:18px;cursor:pointer;accent-color:#8b0000}.checkbox-group span{margin-bottom:0;cursor:pointer;color:#fff;font-size:15px}.link-container{display:flex;gap:10px;margin-top:5px}.link-container input{flex-grow:1;padding:12px;border-radius:6px;border:1px solid #333;background:#2a2a2a;color:#aaa;font-size:13px;outline:none}.link-container button{width:auto;margin-top:0;padding:0 20px;background-color:#8b0000;color:#fff;font-size:14px;font-weight:700;border:none;border-radius:6px;cursor:pointer;transition:background .2s}.link-container button:hover{background-color:#660000}.main-btn{width:100%;padding:14px;border:none;border-radius:6px;background-color:#8b0000;color:#fff;font-size:16px;font-weight:700;cursor:pointer;transition:background .2s;margin-top:10px}.main-btn:hover{background-color:#660000}</style></head><body><div class="container"><h2>TMDB Trending Today Settings</h2><label class="form-group checkbox-group" for="tags"><input type="checkbox" id="tags" checked onchange="updateLink()"><span>Enable Landscape Poster Tags (eg. Coming Soon, New Season etc.)</span></label><label class="form-group checkbox-group" for="ranked"><input type="checkbox" id="ranked" checked onchange="updateLink()"><span>Enable Portrait Ranked Posters</span></label><label class="form-group checkbox-group" for="digitalOnly"><input type="checkbox" id="digitalOnly" checked onchange="updateLink()"><span>Filter Movies Not Released Digitally</span></label><div class="form-group"><label for="listLang">Language Filter</label><select id="listLang" onchange="updateLink()"><option value="all">All</option><option value="en" selected>English</option><option value="non-en">Global (non English)</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="hi">Hindi</option></select></div><div class="form-group"><label for="posterLang">Poster Language</label><select id="posterLang" onchange="updateLink()"><option value="en" selected>English</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="hi">Hindi</option><option value="null">Textless</option></select></div><div class="form-group"><label>Manifest URL</label><div class="link-container"><input type="text" id="manifestUrl" readonly><button id="copyBtn" onclick="copyLink()">Copy</button></div></div><button id="installBtn" class="main-btn">Install</button></div><script>function updateLink(){const t=document.getElementById('tags').checked,r=document.getElementById('ranked').checked,d=document.getElementById('digitalOnly').checked,l=document.getElementById('listLang').value,p=document.getElementById('posterLang').value;const c=\`tags=\${t}|ranked=\${r}|digitalOnly=\${d}|listLang=\${l}|posterLang=\${p}\`;const h=window.location.host,pr=window.location.protocol;document.getElementById('manifestUrl').value=\`\${pr}//\${h}/\${c}/manifest.json\`;document.getElementById('installBtn').onclick=()=>{window.location.href=\`stremio://\${h}/\${c}/manifest.json\`}}function copyLink(){const c=document.getElementById("manifestUrl");c.select();c.setSelectionRange(0,99999);navigator.clipboard.writeText(c.value).then(()=>{const b=document.getElementById("copyBtn");const o=b.innerText;b.innerText="Copied!";b.style.backgroundColor="#660000";setTimeout(()=>{b.innerText=o;b.style.backgroundColor="#8b0000"},2000)})}updateLink();</script></body></html>`;

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

app.get('/', (req, res) => res.send(configUI));
app.get('/configure', (req, res) => res.send(configUI));
app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));
app.get('/:config/manifest.json', (req, res) => res.json(addonInterface.manifest));

app.get('/catalog/:type/:id.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: {} }));
    } catch (err) { res.status(500).json({ err: "Internal Server Error" }); }
});

app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: {} }));
    } catch (err) { res.status(500).json({ err: "Internal Server Error" }); }
});

app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: parseConfig(req.params.config) }));
    } catch (err) { res.status(500).json({ err: "Internal Server Error" }); }
});

app.get('/:config/catalog/:type/:id/:extra.json', async (req, res) => {
    try {
        res.json(await addonInterface.get('catalog', req.params.type, req.params.id, { config: parseConfig(req.params.config) }));
    } catch (err) { res.status(500).json({ err: "Internal Server Error" }); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`Addon active on port ${PORT}`);
});
