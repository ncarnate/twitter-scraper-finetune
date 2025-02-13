# Twitter Scraper

Pipeline for generating AI character files and training datasets by scraping public figures' online presence across Twitter and blogs.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the `.env.example` into a `.env` file and fill in your credentials:
   ```properties
   # (Required) Twitter Authentication
   TWITTER_USERNAME=     # your twitter username
   TWITTER_PASSWORD=     # your twitter password
   TWITTER_EMAIL=        # your twitter email

   # (Optional) Blog Configuration
   BLOG_URLS_FILE=      # path to file containing blog URLs

   # (Optional) Scraping Configuration
   MAX_TWEETS=          # max tweets to scrape
   MAX_RETRIES=         # max retries for scraping
   RETRY_DELAY=         # delay between retries
   MIN_DELAY=           # minimum delay between requests
   MAX_DELAY=           # maximum delay between requests
   ```

## Usage

### Twitter Collection
```bash
npm run twitter -- username
```
Example: `npm run twitter -- pmarca`

### Blog Collection
```bash
npm run blog
```

### Generate Character
```bash
npm run character -- username
```
Example: `npm run character -- pmarca`


The generated character file will be in the `pipeline/[username]/[date]/character/character.json` directory.
The generated tweet dataset file will be in `pipeline/[username]/[date]/raw/tweets.json`.