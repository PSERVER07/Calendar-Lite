# Coming Soon - Tag Logic

This document outlines the various landscape graphic tags applied to content and the specific conditions required for them to appear.

## Movies

Movie tags are calculated using the earliest available **Theatrical** and **Digital (VOD)** release dates from the TMDB API. If a Trakt movie catalog item does not have a TMDB theatrical or digital release date, the addon falls back to Trakt movie releases and uses the first available US or GB matching date.

*   **`In Theaters`**
    *   **Logic:** The movie is **In Theaters**; its theatrical release date was within the last **45 days or fewer**, and it has not been released digitally yet. If its digital release date is **14 days or fewer** away, or it no longer qualifies as a current theatrical release, the tag falls back to the normal **Coming Soon** logic.
*   **`Coming [Month] [Day]`**
    *   **Logic:** The movie has not been released digitally yet, but its digital release date is exactly **14 days or fewer** away.
*   **`Coming Soon [Month] [Day]`**
    *   **Logic:** The movie has not been released digitally yet, and the digital release date is more than **14 days** in the future.
*   **`Coming Soon`**
    *   **Logic:** The movie has not been released digitally yet, and the digital release date is unknown.
*   **`New Release`**
    *   **Logic:** The movie was released digitally within the last **7 days**.
*   **`New Movie`**
    *   **Logic:** The movie was released digitally **8 days or more** ago.

---

## Series (TV Shows)

Series tags are calculated based on a combination of first air dates, recent/upcoming episode broadcast dates, season numbers, and the show's overall status (e.g., Ended/Canceled). Episode dates are resolved using TVMaze first, TMDB as backup, and Trakt calendar as the final fallback; timestamped episode dates are treated as their source calendar date so streaming releases do not shift to the previous evening. When multiple sources provide the same season/episode, TVMaze takes priority over TMDB, and TMDB takes priority over Trakt. If the same source provides different dates for the same season/episode, the earliest date is used. The addon evaluates these conditions in order of priority.

### Upcoming Content
*   **`Coming [Month] [Day]`**
    *   **Logic:** A brand new series *or* the first episode of a new season is scheduled to air within the next **14 days or fewer**.
*   **`Coming Soon [Month] [Day]`**
    *   **Logic:** A brand new series *or* the first episode of a new season is scheduled to air, but the premiere is more than 14 days in the future.
*   **`Finale [Month] [Day]`**
    *   **Logic:** The upcoming episode is confirmed to be a finale (either by the API's `episode_type` or by reaching the season's expected episode count) and is airing within the next **7 days**.

### Recently Aired Content
*   **`Next Episode [Month] [Day]`**
    *   **Logic:** A new episode is going to air within the next **7 days** after the last episode aired **4 or more days** ago.
*   **`New Series`**
    *   **Logic:** A brand new series premiered its very first episode within the last **3 days**.
*   **`New Season`**
    *   **Logic:** A brand new season (season 2 or later) premiered within the last **3 days**.
*   **`Series Finale`**
    *   **Logic:** The series has officially been marked as "Ended" or "Canceled" by TMDB, and its final episode (which is a finale) aired within the last **30 days**.
*   **`Season Finale`**
    *   **Logic:** A season finale aired within the last **30 days**.
*   **`New Episode`**
    *   **Logic:** A standard new episode aired within the last **3 days**.
*   **`Final Season`**
    *   **Logic:** The series has officially been marked as "Ended" or "Canceled" by TMDB, it had more than 1 season, and its very last episode aired within the last **30 days**.
