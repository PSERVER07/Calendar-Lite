# Stremio Trending Addon - Tag Logic

This document outlines the various landscape graphic tags applied to content and the specific conditions required for them to appear.

## Movies

Movie tags are calculated using the earliest available **Theatrical** and **Digital (VOD)** release dates from the TMDB API. If a Trakt movie catalog item does not have a TMDB digital release date, the addon falls back to Trakt movie releases and uses the first available US or GB digital date.

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

Series tags are calculated based on a combination of first air dates, recent/upcoming episode broadcast dates, season numbers, and the show's overall status (e.g., Ended/Canceled). The addon evaluates these conditions in order of priority.

### Upcoming Content
*   **`Coming [Month] [Day]`**
    *   **Logic:** A brand new series *or* the first episode of a new season is scheduled to air within the next **14 days or fewer**.
*   **`Coming Soon [Month] [Day]`**
    *   **Logic:** A brand new series is scheduled to air, but the premiere is more than 14 days in the future.
*   **`Finale [Month] [Day]`**
    *   **Logic:** The upcoming episode is confirmed to be a finale (either by the API's `episode_type` or by reaching the season's expected episode count) and is airing within the next **7 days**.

### Recently Aired Content
*   **`Premiere`**
    *   **Logic:** A brand new series premiered its very first episode within the last **6 days**.
*   **`New Series`**
    *   **Logic:** A brand new series premiered its very first episode between **7 and 13 days** ago.
*   **`New Season`**
    *   **Logic:** A brand new season (season 2 or later) premiered within the last **13 days**.
*   **`Series Finale`**
    *   **Logic:** The series has officially been marked as "Ended" or "Canceled" by TMDB, and its final episode (which is a finale) aired within the last **13 days**.
*   **`Season Finale`**
    *   **Logic:** A season finale aired within the last **13 days**.
*   **`New Episode`**
    *   **Logic:** A standard new episode aired within the last **6 days**.
*   **`Final Season`**
    *   **Logic:** The series has officially been marked as "Ended" or "Canceled" by TMDB, it had more than 1 season, and its very last episode aired within the last **30 days**.
