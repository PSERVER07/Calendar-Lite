# Stremio Trending Addon - Tag Logic

This document outlines the various landscape graphic tags applied to content and the specific conditions required for them to appear.

## Movies

Movie tags are calculated using the earliest available **Theatrical**, **Digital (VOD)**, and **Physical (Blu-ray/DVD)** release dates from the TMDB API.

*   **`Coming [Month] [Day]`**
    *   **Logic:** The movie has not been released digitally yet, but its digital release date is exactly **14 days or fewer** away.
*   **`Coming Soon`**
    *   **Logic:** The movie has not been released digitally yet, and the release date is either unknown or more than 14 days in the future.
*   **`Now on Blu-ray`**
    *   **Logic:** The movie was released on physical media (Blu-ray/DVD/4K) within the last **14 days**.
*   **`Now Streaming`**
    *   **Logic:** The movie was released digitally within the last **14 days**, and it either skipped theaters or its theatrical release date was the same as its digital release date.
*   **`Just Added`**
    *   **Logic:** The movie was released digitally within the last **14 days**, and it had a theatrical release date prior to its digital release.

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
    *   **Logic:** A season finale aired within the last **13 days**.
*   **`New Episode`**
    *   **Logic:** A standard new episode aired within the last **6 days**.
*   **`Final Season`**
    *   **Logic:** The series has officially been marked as "Ended" or "Canceled" by TMDB, it had more than 1 season, and its very last episode aired within the last **30 days**.