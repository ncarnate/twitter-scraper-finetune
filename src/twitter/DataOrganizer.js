// src/utils/DataOrganizer.js
import fs from 'fs/promises';
import path from 'path';
import { format } from 'date-fns';
import Logger from './Logger.js';

class DataOrganizer {
  constructor(baseDir, username) {
    this.baseDir = path.join(baseDir, username.toLowerCase());
    this.createDirectories();
  }

  /**
   * Creates necessary directories for storing data.
   */
  async createDirectories() {
    const dirs = ['raw', 'analytics'];
    for (const dir of dirs) {
      const fullPath = path.join(this.baseDir, dir);
      try {
        await fs.mkdir(fullPath, { recursive: true });
        Logger.info(`✅ Created directory: ${fullPath}`);
      } catch (error) {
        Logger.warn(`⚠️  Failed to create directory ${fullPath}: ${error.message}`);
      }
    }
  }

  /**
   * Returns the file paths for various data categories.
   */
  getPaths() {
    return {
      raw: {
        tweets: path.join(this.baseDir, 'raw', 'tweets.json'),
        metadata: path.join(this.baseDir, 'raw', 'metadata.json'),
      },
      analytics: {
        stats: path.join(this.baseDir, 'analytics', 'stats.json'),
      }
    };
  }

  /**
   * Retrieves the last next_token for pagination.
   * @returns {Promise<string|null>} nextToken - The last next_token or null if not found.
   */
  async getLastNextToken() {
    try {
      const data = await fs.readFile(this.getPaths().meta.nextToken, 'utf-8');
      const trimmed = data.trim();
      Logger.debug(`Retrieved last next_token: ${trimmed}`);
      return trimmed || null;
    } catch (error) {
      Logger.warn(`⚠️  No next_token found. Starting fresh.`);
      return null;
    }
  }

  /**
   * Saves the latest next_token for pagination.
   * @param {string} nextToken - The next_token to save.
   * @returns {Promise<void>}
   */
  async saveNextToken(nextToken) {
    try {
      await fs.writeFile(this.getPaths().meta.nextToken, nextToken, 'utf-8');
      Logger.debug(`✅ Saved next_token: ${nextToken}`);
    } catch (error) {
      Logger.warn(`⚠️  Failed to save next_token: ${error.message}`);
    }
  }

  /**
   * Saves collected tweets and related data.
   * @param {object[]} tweets - Array of tweet objects.
   * @returns {object} analytics - Generated analytics from tweets.
   */
  async saveTweets(tweets) {
    const paths = this.getPaths();

    try {
      // Save raw tweets
      await fs.writeFile(
        paths.raw.tweets,
        JSON.stringify(tweets, null, 2),
        'utf-8'
      );
      Logger.success(`✅ Saved tweets to ${paths.raw.tweets}`);

      // Generate and save analytics
      const analytics = this.generateAnalytics(tweets);
      await fs.writeFile(
        paths.analytics.stats,
        JSON.stringify(analytics, null, 2),
        'utf-8'
      );
      Logger.success(`✅ Saved analytics to ${paths.analytics.stats}`);

      // Save metadata
      await fs.writeFile(
        paths.raw.metadata,
        JSON.stringify({
          last_tweet_id: tweets[tweets.length - 1]?.id,
          last_tweet_date: tweets[tweets.length - 1]?.timestamp,
          total_tweets: tweets.length,
          last_updated: new Date().toISOString()
        }, null, 2),
        'utf-8'
      );

      return analytics;
    } catch (error) {
      Logger.error(`❌ Error saving data: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generates analytics from tweets.
   * @param {object[]} tweets - Array of tweet objects.
   * @returns {object} analytics - Generated analytics data.
   */
  generateAnalytics(tweets) {
    if (tweets.length === 0) {
      Logger.warn('⚠️  No tweets to analyze.');
      return {
        totalTweets: 0,
        directTweets: 0,
        replies: 0,
        retweets: 0,
        engagement: {
          totalLikes: 0,
          totalRetweetCount: 0,
          totalReplies: 0,
          averageLikes: '0.00',
          topTweets: [],
        },
        timeRange: {
          start: 'N/A',
          end: 'N/A',
        },
        contentTypes: {
          withImages: 0,
          withVideos: 0,
          withLinks: 0,
          textOnly: 0,
        },
      };
    }

    const validTweets = tweets.filter((t) => t.timestamp !== null);
    const invalidTweets = tweets.filter((t) => t.timestamp === null);

    if (invalidTweets.length > 0) {
      Logger.warn(
        `⚠️  Found ${invalidTweets.length} tweets with invalid or missing dates. They will be excluded from analytics.`
      );
    }

    const validDates = validTweets
      .map((t) => t.timestamp)
      .sort((a, b) => a - b);

    const tweetsForEngagement = tweets.filter((t) => !t.isRetweet);

    return {
      totalTweets: tweets.length,
      directTweets: tweets.filter((t) => !t.isReply && !t.isRetweet).length,
      replies: tweets.filter((t) => t.isReply).length,
      retweets: tweets.filter((t) => t.isRetweet).length,
      engagement: {
        totalLikes: tweetsForEngagement.reduce(
          (sum, t) => sum + (t.likes || 0),
          0
        ),
        totalRetweetCount: tweetsForEngagement.reduce(
          (sum, t) => sum + (t.retweetCount || 0),
          0
        ),
        totalReplies: tweetsForEngagement.reduce(
          (sum, t) => sum + (t.replies || 0),
          0
        ),
        averageLikes: (
          tweetsForEngagement.reduce((sum, t) => sum + (t.likes || 0), 0) /
          tweetsForEngagement.length
        ).toFixed(2),
        topTweets: tweetsForEngagement
          .sort((a, b) => (b.likes || 0) - (a.likes || 0))
          .slice(0, 5)
          .map((t) => ({
            id: t.id,
            text: t.text.slice(0, 100),
            likes: t.likes,
            retweetCount: t.retweetCount,
            url: t.permanentUrl,
          })),
      },
      timeRange: {
        start: validDates.length
          ? format(new Date(validDates[0]), 'yyyy-MM-dd')
          : 'N/A',
        end: validDates.length
          ? format(new Date(validDates[validDates.length - 1]), 'yyyy-MM-dd')
          : 'N/A',
      },
      contentTypes: {
        withImages: tweets.filter((t) => t.photos?.length > 0).length,
        withVideos: tweets.filter((t) => t.videos?.length > 0).length,
        withLinks: tweets.filter((t) => t.urls?.length > 0).length,
        textOnly: tweets.filter(
          (t) => !t.photos?.length && !t.videos?.length && !t.urls?.length
        ).length,
      },
    };
  }

  /**
   * Generates a summary of the collected data.
   * @param {object[]} tweets - Array of tweet objects.
   * @param {object} analytics - Generated analytics data.
   * @returns {string} summary - Markdown formatted summary.
   */
  generateSummary(tweets, analytics) {
    return `# Twitter Data Collection Summary

## Overview
- **Collection Date:** ${format(new Date(), 'yyyy-MM-dd HH:mm:ss')}
- **Total Tweets:** ${analytics.totalTweets}
- **Date Range:** ${analytics.timeRange.start} to ${analytics.timeRange.end}

## Tweet Distribution
- **Direct Tweets:** ${analytics.directTweets}
- **Replies:** ${analytics.replies}
- **Retweets (retweeted tweets):** ${analytics.retweets}

## Content Types
- **With Images:** ${analytics.contentTypes.withImages}
- **With Videos:** ${analytics.contentTypes.withVideos}
- **With Links:** ${analytics.contentTypes.withLinks}
- **Text Only:** ${analytics.contentTypes.textOnly}

## Engagement Statistics (Original Tweets and Replies)
- **Total Likes:** ${analytics.engagement.totalLikes.toLocaleString()}
- **Total Retweet Count:** ${analytics.engagement.totalRetweetCount.toLocaleString()}
- **Total Replies:** ${analytics.engagement.totalReplies.toLocaleString()}
- **Average Likes per Tweet:** ${analytics.engagement.averageLikes}

## Top Tweets
${analytics.engagement.topTweets
  .map((t) => `- [${t.likes} likes] ${t.text}...\n  • ${t.url}`)
  .join('\n\n')}

## Storage Details
Raw data, analytics, and exports can be found in:
**${this.baseDir}**
`;
  }

  async load_existing_tweets() {
    try {
      const existing = await fs.readFile(this.getPaths().raw.tweets, 'utf-8');
      return JSON.parse(existing);
    } catch {
      return [];
    }
  }

  async save_tweet_batch(new_tweets) {
    // Load existing
    const existing_tweets = await this.load_existing_tweets();
    
    // Merge without duplicates using Map
    const tweet_map = new Map();
    
    // Add existing tweets to map
    existing_tweets.forEach(tweet => {
      tweet_map.set(tweet.id, tweet);
    });
    
    // Add new tweets, overwriting if newer version exists
    new_tweets.forEach(tweet => {
      tweet_map.set(tweet.id, tweet);
    });

    // Convert back to array and sort by date
    const merged = Array.from(tweet_map.values())
      .sort((a, b) => b.timestamp - a.timestamp);

    // Save merged tweets
    await fs.writeFile(
      this.getPaths().raw.tweets,
      JSON.stringify(merged, null, 2),
      'utf-8'
    );

    // Save collection metadata (replaces old meta/progress path)
    await fs.writeFile(
      this.getPaths().raw.metadata,
      JSON.stringify({
        last_tweet_id: merged[merged.length - 1]?.id,
        last_tweet_date: merged[merged.length - 1]?.timestamp,
        total_tweets: merged.length,
        last_updated: new Date().toISOString()
      }, null, 2),
      'utf-8'
    );

    return merged;
  }

  async get_collection_state() {
    try {
        const existing_tweets = await this.load_existing_tweets();
        if (!existing_tweets.length) return null;

        // Sort by timestamp (newest first)
        existing_tweets.sort((a, b) => b.timestamp - a.timestamp);

        return {
            newest_tweet_timestamp: existing_tweets[0].timestamp,
            oldest_tweet_timestamp: existing_tweets[existing_tweets.length - 1].timestamp,
            total_tweets: existing_tweets.length,
            last_updated: new Date().toISOString()
        };
    } catch {
        return null;
    }
  }
}

export default DataOrganizer;
