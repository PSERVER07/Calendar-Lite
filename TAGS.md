# Stremio Trending Addon - Tag Logic

This document outlines the various landscape graphic tags applied to content and the specific conditions required for them to appear.

## Movies

Movie tags are strictly based on the **Digital Release Date** (types 4 and 5 in the TMDB release dates API) rather than theatrical release dates.

*   **`Coming [Month] [Day]`**
    *   **Logic:** The movie has not been released digitally yet, but its digital release date is exactly **14 days or fewer** away.
*   **`Coming Soon`**
    *   **Logic:** The movie has not been released digitally yet, and the release date is either unknown or more than 14 days in the future.
*   **`Just Added`**
    *   **Logic:** The movie was released digitally within the last **7 days**.
*   **`New Movie`**
    *   **Logic:** The movie was released digitally between **8 and 30 days** ago.

---

## Series (TV Shows)

Series tags are calculated based on a combination of first air dates, recent/upcoming episode broadcast dates, season numbers, and the show's overall status (e.g., Ended/Canceled). The addon evaluates these conditions in order of priority.

### Upcoming Content
*   **`Coming [Month] [Day]`**
    *   **Logic:** A brand new series *or* the first episode of a new season is scheduled to air within the next **14 days**.
*   **`Coming Soon`**
    *   **Logic:** A brand new series is scheduled to air, but the premiere is more than 14 days in the future.
*   **`Finale [Month] [Day]`**
    *   **Logic:** The upcoming episode is confirmed to be a finale (either by the API's `episode_type` or by reaching the season's expected episode count) and is airing within the next **5 days**.

### Recently Aired Content
*   **`Premiere`**
    *   **Logic:** A brand new series premiered its very first episode within the last **6 days**.
*   **`New Series`**
    *   **Logic:** A brand new series premiered its very first episode between **7 and 13 days** ago.
*   **`New Season`**
    *   **Logic:** A brand new season (season 2 or later) premiered within the last **13 days**.
*   **`Season Finale`**
    *   **Logic:** A season finale aired within the last **6 days**.
*   **`New Episode`**
    *   **Logic:** A standard new episode aired within the last **6 days**.
*   **`Final Season`**
    *   **Logic:** The series has officially been marked as "Ended" or "Canceled" by TMDB, it had more than 1 season, and its very last episode aired within the last **30 days**.