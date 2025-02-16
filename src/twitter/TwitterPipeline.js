import inquirer from "inquirer";
import chalk from "chalk";
import { format } from "date-fns";
import path from "path";
import fs from "fs/promises";

// Imported Files
import Logger from "./Logger.js";
import DataOrganizer from "./DataOrganizer.js";
import TweetFilter from "./TweetFilter.js";

// agent-twitter-client
import { Scraper, SearchMode } from "agent-twitter-client";

// Puppeteer
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import { Cluster } from "puppeteer-cluster";

// Configure puppeteer stealth once
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

class TwitterPipeline {
  constructor(username, dataDir) {
    this.username = username;
    this.dataOrganizer = new DataOrganizer(dataDir, username);
    this.paths = this.dataOrganizer.getPaths();
    this.tweetFilter = new TweetFilter();

    // Update cookie path to be in top-level cookies directory
    this.paths.cookies = path.join(
      process.cwd(),
      'cookies',
      `${process.env.TWITTER_USERNAME}_cookies.json`
    );

    // Enhanced configuration with fallback handling
    this.config = {
      twitter: {
        maxTweets: parseInt(process.env.MAX_TWEETS) || 50000,
        maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
        retryDelay: parseInt(process.env.RETRY_DELAY) || 5000,
        minDelayBetweenRequests: parseInt(process.env.MIN_DELAY) || 1000,
        maxDelayBetweenRequests: parseInt(process.env.MAX_DELAY) || 3000,
        rateLimitThreshold: 3, // Number of rate limits before considering fallback
      },
      fallback: {
        enabled: true,
        sessionDuration: 30 * 60 * 1000, // 30 minutes
        viewport: {
          width: 1366,
          height: 768,
          deviceScaleFactor: 1,
          hasTouch: false,
          isLandscape: true,
        },
      },
    };

    this.scraper = new Scraper();
    this.cluster = null;

    // Enhanced statistics tracking
    this.stats = {
      requestCount: 0,
      rateLimitHits: 0,
      retriesCount: 0,
      uniqueTweets: 0,
      fallbackCount: 0,
      startTime: Date.now(),
      oldestTweetDate: null,
      newestTweetDate: null,
      fallbackUsed: false,
    };
  }

  async initializeFallback() {
    if (!this.cluster) {
      this.cluster = await Cluster.launch({
        puppeteer,
        maxConcurrency: 1, // Single instance for consistency
        timeout: 30000,
        puppeteerOptions: {
          headless: "new",
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
          ],
        },
      });

      this.cluster.on("taskerror", async (err) => {
        Logger.warn(`Fallback error: ${err.message}`);
        this.stats.retriesCount++;
      });
    }
  }

  async setupFallbackPage(page) {
    await page.setViewport(this.config.fallback.viewport);

    // Basic evasion only - maintain consistency
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
  }

  async validateEnvironment() {
    Logger.startSpinner("Validating environment");
    const required = ["TWITTER_USERNAME", "TWITTER_PASSWORD"];
    const missing = required.filter((var_) => !process.env[var_]);

    if (missing.length > 0) {
      Logger.stopSpinner(false);
      Logger.error("Missing required environment variables:");
      missing.forEach((var_) => Logger.error(`- ${var_}`));
      console.log("\n📝 Create a .env file with your Twitter credentials:");
      console.log(`TWITTER_USERNAME=your_username`);
      console.log(`TWITTER_PASSWORD=your_password`);
      process.exit(1);
    }
    Logger.stopSpinner();
  }

async loadCookies() {
    try {
      if (await fs.access(this.paths.cookies).catch(() => false)) {
        const cookiesData = await fs.readFile(this.paths.cookies, 'utf-8');
        const cookies = JSON.parse(cookiesData);
        await this.scraper.setCookies(cookies);
        return true;
      }
    } catch (error) {
      Logger.warn(`Failed to load cookies: ${error.message}`);
    }
    return false;
}

async saveCookies() {
    try {
      const cookies = await this.scraper.getCookies();
      // Create cookies directory if it doesn't exist
      await fs.mkdir(path.dirname(this.paths.cookies), { recursive: true });
      await fs.writeFile(this.paths.cookies, JSON.stringify(cookies));
      Logger.success('Saved authentication cookies');
    } catch (error) {
      Logger.warn(`Failed to save cookies: ${error.message}`);
    }
}


  async initializeScraper() {
    Logger.startSpinner("Initializing Twitter scraper");
    let retryCount = 0;

    // Try loading cookies first
    if (await this.loadCookies()) {
      try {
        if (await this.scraper.isLoggedIn()) {
          Logger.success("✅ Successfully authenticated with saved cookies");
          Logger.stopSpinner();
          return true;
        }
      } catch (error) {
        Logger.warn("Saved cookies are invalid, attempting fresh login");
      }
    }

    // Verify all required credentials are present
    const username = process.env.TWITTER_USERNAME;
    const password = process.env.TWITTER_PASSWORD;
    const email = process.env.TWITTER_EMAIL;

    if (!username || !password || !email) {
      Logger.error("Missing required credentials. Need username, password, AND email");
      Logger.stopSpinner(false);
      return false;
    }

    // Attempt login with email verification
    while (retryCount < this.config.twitter.maxRetries) {
      try {
        // Add random delay before login attempt
        await this.randomDelay(5000, 10000);

        // Always use email in login attempt
        await this.scraper.login(username, password, email);

        // Verify login success
        const isLoggedIn = await this.scraper.isLoggedIn();
        if (isLoggedIn) {
          await this.saveCookies();
          Logger.success("✅ Successfully authenticated with Twitter");
          Logger.stopSpinner();
          return true;
        } else {
          throw new Error("Login verification failed");
        }

      } catch (error) {
        retryCount++;
        Logger.warn(
          `⚠️  Authentication attempt ${retryCount} failed: ${error.message}`
        );

        if (retryCount >= this.config.twitter.maxRetries) {
          Logger.stopSpinner(false);
          return false;
        }

        // Exponential backoff with jitter
        const baseDelay = this.config.twitter.retryDelay * Math.pow(2, retryCount - 1);
        const maxJitter = baseDelay * 0.2; // 20% jitter
        const jitter = Math.floor(Math.random() * maxJitter);
        await this.randomDelay(baseDelay + jitter, baseDelay + jitter + 5000);
      }
    }
    return false;
  }


  async randomDelay(min, max) {
    // Gaussian distribution for more natural delays
    const gaussianRand = () => {
      let rand = 0;
      for (let i = 0; i < 6; i++) rand += Math.random();
      return rand / 6;
    };

    const delay = Math.floor(min + gaussianRand() * (max - min));
    Logger.info(`Waiting ${(delay / 1000).toFixed(1)} seconds...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /*
  async initializeScraper() {
    Logger.startSpinner("Initializing Twitter scraper");
    let retryCount = 0;

    while (retryCount < this.config.twitter.maxRetries) {
      try {
        const username = process.env.TWITTER_USERNAME;
        const password = process.env.TWITTER_PASSWORD;

        if (!username || !password) {
          throw new Error("Twitter credentials not found");
        }

        // Try login with minimal parameters first
        await this.scraper.login(username, password);

        if (await this.scraper.isLoggedIn()) {
          Logger.success("✅ Successfully authenticated with Twitter");
          Logger.stopSpinner();
          return true;
        } else {
          throw new Error("Authentication failed");
        }
      } catch (error) {
        retryCount++;
        Logger.warn(
          `⚠️  Authentication attempt ${retryCount} failed: ${error.message}`
        );

        if (retryCount >= this.config.twitter.maxRetries) {
          Logger.stopSpinner(false);
          // Don't throw - allow fallback
          return false;
        }

        await this.randomDelay(
          this.config.twitter.retryDelay * retryCount,
          this.config.twitter.retryDelay * retryCount * 2
        );
      }
    }
    return false;
  }   */

  async randomDelay(min = null, max = null) {
    const minDelay = min || this.config.twitter.minDelayBetweenRequests;
    const maxDelay = max || this.config.twitter.maxDelayBetweenRequests;

    // Use gaussian distribution for more natural delays
    const gaussianRand = () => {
      let rand = 0;
      for (let i = 0; i < 6; i++) rand += Math.random();
      return rand / 6;
    };

    const delay = Math.floor(minDelay + gaussianRand() * (maxDelay - minDelay));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async handleRateLimit(retryCount = 1) {
    this.stats.rateLimitHits++;
    const baseDelay = 60000; // 1 minute
    const maxDelay = 15 * 60 * 1000; // 15 minutes

    // Exponential backoff with small jitter
    const exponentialDelay = baseDelay * Math.pow(2, retryCount - 1);
    const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
    const delay = Math.min(exponentialDelay + jitter, maxDelay);

    Logger.warn(
      `⚠️  Rate limit hit - waiting ${
        delay / 1000
      } seconds (attempt ${retryCount})`
    );

    await this.randomDelay(delay, delay * 1.1);
  }

  processTweetData(tweet) {
    try {
      if (!tweet || !tweet.id) return null;

      let timestamp = tweet.timestamp;
      if (!timestamp) {
        timestamp = tweet.timeParsed?.getTime();
      }

      if (!timestamp) return null;

      if (timestamp < 1e12) timestamp *= 1000;

      if (isNaN(timestamp) || timestamp <= 0) {
        Logger.warn(`⚠️  Invalid timestamp for tweet ${tweet.id}`);
        return null;
      }

      const tweetDate = new Date(timestamp);
      if (
        !this.stats.oldestTweetDate ||
        tweetDate < this.stats.oldestTweetDate
      ) {
        this.stats.oldestTweetDate = tweetDate;
      }
      if (
        !this.stats.newestTweetDate ||
        tweetDate > this.stats.newestTweetDate
      ) {
        this.stats.newestTweetDate = tweetDate;
      }

      return {
        id: tweet.id,
        text: tweet.text,
        username: tweet.username || this.username,
        timestamp,
        createdAt: new Date(timestamp).toISOString(),
        isReply: Boolean(tweet.isReply),
        isRetweet: Boolean(tweet.isRetweet),
        likes: tweet.likes || 0,
        retweetCount: tweet.retweets || 0,
        replies: tweet.replies || 0,
        photos: tweet.photos || [],
        videos: tweet.videos || [],
        urls: tweet.urls || [],
        permanentUrl: tweet.permanentUrl,
        quotedStatusId: tweet.quotedStatusId,
        inReplyToStatusId: tweet.inReplyToStatusId,
        hashtags: tweet.hashtags || [],
      };
    } catch (error) {
      Logger.warn(`⚠️  Error processing tweet ${tweet?.id}: ${error.message}`);
      return null;
    }
  }

  async collectWithFallback(searchQuery) {
    if (!this.cluster) {
      await this.initializeFallback();
    }

    const tweets = new Set();
    let sessionStartTime = Date.now();

    const fallbackTask = async ({ page }) => {
      await this.setupFallbackPage(page);

      try {
        // Login with minimal interaction
        await page.goto("https://twitter.com/login", {
          waitUntil: "networkidle0",
          timeout: 30000,
        });

        // More reliable selectors
        await page.waitForSelector('input[autocomplete="username"]');
        await page.type('input[autocomplete="username"]', process.env.TWITTER_USERNAME);
        await this.randomDelay(500, 1000);
        
        // Use a more reliable next button selector
        await page.waitForSelector('[data-testid="next_button"]');
        await page.click('[data-testid="next_button"]');
        
        await this.randomDelay(500, 1000);
        await page.type('input[type="password"]', process.env.TWITTER_PASSWORD);
        await this.randomDelay(500, 1000);
        
        await page.waitForSelector('[data-testid="LoginButton"]');
        await page.click('[data-testid="LoginButton"]');
        
        await page.waitForNavigation({ waitUntil: "networkidle0" });

        // Go directly to search
        await page.goto(
          `https://twitter.com/search?q=${encodeURIComponent(
            searchQuery
          )}&f=live`
        );
        await this.randomDelay(1000, 2000);

        let lastTweetCount = 0;
        let unchangedCount = 0;

        while (
          unchangedCount < 3 &&
          Date.now() - sessionStartTime < this.config.fallback.sessionDuration
        ) {
          await page.evaluate(() => {
            window.scrollBy(0, 500);
          });

          await this.randomDelay(1000, 2000);

          const newTweets = await page.evaluate(() => {
            const tweetElements = Array.from(
              document.querySelectorAll('article[data-testid="tweet"]')
            );
            return tweetElements
              .map((tweet) => {
                try {
                  return {
                    id: tweet.getAttribute("data-tweet-id"),
                    text: tweet.querySelector("div[lang]")?.textContent || "",
                    timestamp: tweet
                      .querySelector("time")
                      ?.getAttribute("datetime"),
                    metrics: Array.from(
                      tweet.querySelectorAll('span[data-testid$="count"]')
                    ).map((m) => m.textContent),
                  };
                } catch (e) {
                  return null;
                }
              })
              .filter((t) => t && t.id);
          });

          for (const tweet of newTweets) {
            if (!tweets.has(tweet.id)) {
              tweets.add(tweet);
              this.stats.fallbackCount++;
            }
          }

          if (tweets.size === lastTweetCount) {
            unchangedCount++;
          } else {
            unchangedCount = 0;
            lastTweetCount = tweets.size;
          }
        }
      } catch (error) {
        Logger.warn(`Fallback collection error: ${error.message}`);
        throw error;
      }
    };

    await this.cluster.task(fallbackTask);
    await this.cluster.queue({});

    return Array.from(tweets);
  }

  async collectTweets(scraper) {
    try {
        const profile = await scraper.getProfile(this.username);
        const totalExpectedTweets = profile.tweetsCount;
        Logger.info(`📊 Found ${totalExpectedTweets.toLocaleString()} total tweets for @${this.username}`);

        // Get existing collection state
        const collection_state = await this.dataOrganizer.get_collection_state();
        const allTweets = new Map();

        // Load existing tweets
        const existing_tweets = await this.dataOrganizer.load_existing_tweets();
        if (existing_tweets.length) {
            Logger.info(`📥 Resuming collection from ${existing_tweets.length} existing tweets`);
            existing_tweets.forEach(tweet => allTweets.set(tweet.id, tweet));
        }

        // 1. First get any new tweets
        if (collection_state) {
            Logger.info('🔄 Checking for new tweets...');
            const newTweetsSearch = scraper.searchTweets(
                `from:${this.username}`,
                100,  // Reasonable batch for new tweets
                SearchMode.Latest
            );

            for await (const tweet of newTweetsSearch) {
                if (tweet.timestamp <= collection_state.newest_tweet_timestamp) break;
                
                if (!allTweets.has(tweet.id)) {
                    const processedTweet = this.processTweetData(tweet);
                    if (processedTweet) {
                        allTweets.set(tweet.id, processedTweet);
                        Logger.info(`📌 Found new tweet from ${format(new Date(tweet.timestamp), 'yyyy-MM-dd HH:mm')}`);
                    }
                }
            }
        }

        // 2. Then get older tweets if needed
        if (allTweets.size < this.config.twitter.maxTweets) {
            const remaining = this.config.twitter.maxTweets - allTweets.size;
            Logger.info(`📜 Collecting ${remaining} older tweets (${allTweets.size}/${this.config.twitter.maxTweets} total)...`);

            // Get all existing tweet IDs for better filtering
            const existing_ids = new Set(Array.from(allTweets.keys()));
            
            // Keep track of seen tweets in this batch
            let new_tweets_count = 0;
            
            const olderTweetsSearch = scraper.searchTweets(
                `from:${this.username}`,
                this.config.twitter.maxTweets * 2, // Request more to ensure we get enough unique ones
                SearchMode.Latest
            );

            for await (const tweet of olderTweetsSearch) {
                // Skip if we have this tweet
                if (existing_ids.has(tweet.id)) continue;
                
                const processedTweet = this.processTweetData(tweet);
                if (processedTweet) {
                    allTweets.set(tweet.id, processedTweet);
                    existing_ids.add(tweet.id);
                    new_tweets_count++;
                    Logger.info(`📜 Found older tweet from ${format(tweet.timestamp, 'yyyy-MM-dd HH:mm')}`);
                    
                    // Break if we have enough new tweets
                    if (new_tweets_count >= remaining) break;
                }
            }
        }

        // Final save
        const finalTweets = Array.from(allTweets.values());
        await this.dataOrganizer.save_tweet_batch(finalTweets);

        Logger.success(`\n🎉 Collection complete! ${allTweets.size} unique tweets collected`);
        return finalTweets;

    } catch (error) {
        Logger.error(`Failed to collect tweets: ${error.message}`);
        throw error;
    }
  }

  // Updated showSampleTweets function that logs sample tweets automatically
  async showSampleTweets(tweets) {
    Logger.info("\n🌟 Sample Tweets (Most Engaging):");

    const sorted_tweets = tweets
      .filter(tweet => !tweet.isRetweet)
      .sort((a, b) => (b.likes + b.retweetCount) - (a.likes + a.retweetCount))
      .slice(0, 5);

    sorted_tweets.forEach((tweet, i) => {
      console.log(
        chalk.cyan(
          `\n${i + 1}. [${format(new Date(tweet.timestamp), "yyyy-MM-dd")}]`
        )
      );
      console.log(chalk.white(tweet.text));
      console.log(
        chalk.gray(
          `❤️ ${tweet.likes.toLocaleString()} | 🔄 ${tweet.retweetCount.toLocaleString()} | 💬 ${tweet.replies.toLocaleString()}`
        )
      );
      console.log(chalk.gray(`🔗 ${tweet.permanentUrl}`));
    });
  }

  async getProfile() {
    const profile = await this.scraper.getProfile(this.username);
    return profile;
  }

  async run() {
    const startTime = Date.now();

    console.log("\n" + chalk.bold.blue("🐦 Twitter Data Collection Pipeline"));
    console.log(
      chalk.bold(`Target Account: ${chalk.cyan("@" + this.username)}\n`)
    );

    try {
      await this.validateEnvironment();

      // Initialize main scraper
      const scraperInitialized = await this.initializeScraper();
      if (!scraperInitialized && !this.config.fallback.enabled) {
        throw new Error(
          "Failed to initialize scraper and fallback is disabled"
        );
      }

      // Start collection
      Logger.startSpinner(`Collecting tweets from @${this.username}`);
      const allTweets = await this.collectTweets(this.scraper);
      Logger.stopSpinner();

      if (allTweets.length === 0) {
        Logger.warn("⚠️  No tweets collected");
        return;
      }

      // Save collected data
      Logger.startSpinner("Processing and saving data");
      const analytics = await this.dataOrganizer.saveTweets(allTweets);
      Logger.stopSpinner();

      // Calculate final statistics
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const tweetsPerMinute = (allTweets.length / (duration / 60)).toFixed(1);
      const total_attempts = this.stats.requestCount + this.stats.fallbackCount;
      const success_rate = total_attempts > 0 
          ? ((allTweets.length / total_attempts) * 100).toFixed(1)
          : '100.0';

      // Display final results
      Logger.stats("📈 Collection Results", {
        "Total Tweets": allTweets.length.toLocaleString(),
        "Original Tweets": analytics.directTweets.toLocaleString(),
        "Replies": analytics.replies.toLocaleString(),
        "Retweets": analytics.retweets.toLocaleString(),
        "Date Range": `${analytics.timeRange.start} to ${analytics.timeRange.end}`,
        "Runtime": `${duration} seconds`,
        "Collection Rate": `${tweetsPerMinute} tweets/minute`,
        "Success Rate": `${success_rate}%`,
        "Rate Limit Hits": this.stats.rateLimitHits.toLocaleString(),
        "Fallback Collections": this.stats.fallbackCount.toLocaleString(),
        "Storage Location": chalk.gray(this.dataOrganizer.baseDir),
      });

      // Content type breakdown
      Logger.info("\n📊 Content Type Breakdown:");
      console.log(
        chalk.cyan(
          `• Text Only: ${analytics.contentTypes.textOnly.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(
          `• With Images: ${analytics.contentTypes.withImages.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(
          `• With Videos: ${analytics.contentTypes.withVideos.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(
          `• With Links: ${analytics.contentTypes.withLinks.toLocaleString()}`
        )
      );

      // Engagement statistics
      Logger.info("\n💫 Engagement Statistics:");
      console.log(
        chalk.cyan(
          `• Total Likes: ${analytics.engagement.totalLikes.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(
          `• Total Retweets: ${analytics.engagement.totalRetweetCount.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(
          `• Total Replies: ${analytics.engagement.totalReplies.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(`• Average Likes: ${analytics.engagement.averageLikes}`)
      );

      // Collection method breakdown
      if (this.stats.fallbackUsed) {
        Logger.info("\n🔄 Collection Method Breakdown:");
        console.log(
          chalk.cyan(
            `• Primary Collection: ${(
              allTweets.length - this.stats.fallbackCount
            ).toLocaleString()}`
          )
        );
        console.log(
          chalk.cyan(
            `• Fallback Collection: ${this.stats.fallbackCount.toLocaleString()}`
          )
        );
      }

      // Show sample tweets
      await this.showSampleTweets(allTweets);

      // Cleanup
      await this.cleanup();

      return analytics;
    } catch (error) {
      Logger.error(`Pipeline failed: ${error.message}`);
      await this.logError(error, {
        stage: "pipeline_execution",
        runtime: (Date.now() - startTime) / 1000,
        stats: this.stats,
      });
      await this.cleanup();
      throw error;
    }
  }

  async logError(error, context = {}) {
    const errorLog = {
      timestamp: new Date().toISOString(),
      error: {
        message: error.message,
        stack: error.stack,
      },
      context: {
        ...context,
        username: this.username,
        sessionDuration: Date.now() - this.stats.startTime,
        rateLimitHits: this.stats.rateLimitHits,
        fallbackUsed: this.stats.fallbackUsed,
        fallbackCount: this.stats.fallbackCount,
      },
      stats: this.stats,
      config: {
        delays: {
          min: this.config.twitter.minDelayBetweenRequests,
          max: this.config.twitter.maxDelayBetweenRequests,
        },
        retries: this.config.twitter.maxRetries,
        fallback: {
          enabled: this.config.fallback.enabled,
          sessionDuration: this.config.fallback.sessionDuration,
        },
      },
    };

    const errorLogPath = path.join(
      this.dataOrganizer.baseDir,
      "raw",
      "error_log.json"
    );

    try {
      let existingLogs = [];
      try {
        const existing = await fs.readFile(errorLogPath, "utf-8");
        existingLogs = JSON.parse(existing);
      } catch {
        // File doesn't exist yet
      }

      existingLogs.push(errorLog);

      // Keep only recent errors
      if (existingLogs.length > 100) {
        existingLogs = existingLogs.slice(-100);
      }

      await fs.writeFile(errorLogPath, JSON.stringify(existingLogs, null, 2));
    } catch (logError) {
      Logger.error(`Failed to save error log: ${logError.message}`);
    }
  }

  async cleanup() {
    try {
        Logger.warn('\n🛑 Starting cleanup process...');

        // Save final stats first
        try {
            const finalStats = {
                completed: true,
                endTime: new Date().toISOString(),
                runtime: {
                    seconds: ((Date.now() - this.stats.startTime) / 1000).toFixed(1)
                },
                collection: {
                    totalTweets: this.stats.uniqueTweets || 0,
                    fallbackUsed: this.stats.fallbackUsed || false,
                    fallbackCount: this.stats.fallbackCount || 0,
                    rateLimitHits: this.stats.rateLimitHits || 0
                }
            };

            const statsPath = path.join(
                this.dataOrganizer.baseDir,
                'analytics',
                'final_stats.json'
            );

            await fs.writeFile(
                statsPath,
                JSON.stringify(finalStats, null, 2)
            );
            Logger.success('📊 Saved final statistics');
        } catch (statsError) {
            Logger.warn(`⚠️  Could not save final statistics: ${statsError.message}`);
        }

        // Cleanup fallback system first
        if (this.cluster) {
            await this.cluster.close();
            this.cluster = null; // Ensure it's nullified
            Logger.success('🔒 Cleaned up fallback system');
        }

        // Then cleanup main scraper
        if (this.scraper) {
            await this.scraper.logout();
            Logger.success('🔒 Logged out of primary system');
        }

        Logger.success('✨ Cleanup complete');
        
        // Force exit after cleanup
        process.exit(0);
    } catch (error) {
        Logger.error(`❌ Cleanup error: ${error.message}`);
        process.exit(1);
    }
  }
}

export default TwitterPipeline;