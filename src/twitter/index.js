// index.js
import dotenv from 'dotenv';
import path from 'path';
dotenv.config();

import TwitterPipeline from './TwitterPipeline.js';
import Logger from './Logger.js';

process.on('unhandledRejection', (error) => {
  Logger.error(`❌ Unhandled promise rejection: ${error.message}`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  Logger.error(`❌ Uncaught exception: ${error.message}`);
  process.exit(1);
});

const raw_args = process.argv.slice(2);

let username = 'degenspartan';
let output_dir = path.join(process.cwd(), '..', 'data');

for (let i = 0; i < raw_args.length; i++) {
  const arg = raw_args[i];
  if (!arg.startsWith('--')) {
    // The first non-flag argument is the username
    username = arg;
  } else if (arg === '--output') {
    output_dir = raw_args[++i] || output_dir;
  }
}

const pipeline = new TwitterPipeline(username, output_dir);

const cleanup = async () => {
  Logger.warn('\n🛑 Received termination signal. Cleaning up...');
  try {
    if (pipeline.scraper) {
      await pipeline.scraper.logout();
      Logger.success('🔒 Logged out successfully.');
    }
  } catch (error) {
    Logger.error(`❌ Error during cleanup: ${error.message}`);
  }
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

pipeline.run().catch(() => process.exit(1));
