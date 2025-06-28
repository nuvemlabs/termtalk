#!/usr/bin/env node

const fs = require("fs");
const https = require("https");
const { spawn } = require("child_process");
const path = require("path");

const DEEPGRAM_URL = "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en";

class DeepgramTTSPlayer {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.DEEPGRAM_API_KEY;
    this.saveToFile = options.saveToFile !== false;
    this.playRealTime = options.playRealTime || false;
    this.audioFilePath = options.audioFilePath || "output.mp3";
    this.cleanup = options.cleanup !== false;
    this.model = options.model || "aura-2-thalia-en";
    this.verbose = options.verbose || false;
    
    if (!this.apiKey) {
      throw new Error("DEEPGRAM_API_KEY environment variable or --api-key option is required");
    }
  }

  log(message) {
    if (this.verbose) {
      console.log(message);
    }
  }

  async downloadAndPlay(text) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ text });
      
      const requestConfig = {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      };

      let fileStream;
      if (this.saveToFile) {
        fileStream = fs.createWriteStream(this.audioFilePath);
      }

      this.log("Downloading audio...");
      const req = https.request(`${DEEPGRAM_URL.replace('aura-2-thalia-en', this.model)}`, requestConfig, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        res.on("data", (chunk) => {
          if (fileStream) {
            fileStream.write(chunk);
          }
        });

        res.on("end", async () => {
          this.log("Audio download complete");
          
          if (fileStream) {
            fileStream.end();
            
            setTimeout(async () => {
              try {
                await this.playAudioFile(this.audioFilePath);
                
                if (this.cleanup && fs.existsSync(this.audioFilePath)) {
                  fs.unlinkSync(this.audioFilePath);
                  this.log("Temporary audio file cleaned up");
                }
                
                resolve();
              } catch (error) {
                reject(error);
              }
            }, 100);
          } else {
            resolve();
          }
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      req.write(payload);
      req.end();
    });
  }

  async streamAndPlay(text) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ text });
      
      const requestConfig = {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      };

      const audioPlayer = this.createStreamingPlayer();
      if (!audioPlayer) {
        reject(new Error("Could not create audio player for streaming"));
        return;
      }

      let fileStream;
      if (this.saveToFile) {
        fileStream = fs.createWriteStream(this.audioFilePath);
      }

      this.log("Starting real-time audio streaming...");
      const req = https.request(`${DEEPGRAM_URL.replace('aura-2-thalia-en', this.model)}`, requestConfig, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        res.on("data", (chunk) => {
          if (audioPlayer && audioPlayer.stdin && !audioPlayer.stdin.destroyed) {
            audioPlayer.stdin.write(chunk);
          }
          
          if (fileStream) {
            fileStream.write(chunk);
          }
        });

        res.on("end", () => {
          this.log("Audio stream complete");
          
          if (audioPlayer && audioPlayer.stdin && !audioPlayer.stdin.destroyed) {
            audioPlayer.stdin.end();
          }
          
          if (fileStream) {
            fileStream.end();
          }
        });
      });

      if (audioPlayer) {
        audioPlayer.on("close", (code) => {
          this.log("Audio playback finished");
          
          if (this.cleanup && this.saveToFile && fs.existsSync(this.audioFilePath)) {
            fs.unlinkSync(this.audioFilePath);
            this.log("Temporary audio file cleaned up");
          }
          
          resolve();
        });

        audioPlayer.on("error", (error) => {
          reject(error);
        });
      }

      req.on("error", (error) => {
        reject(error);
      });

      req.write(payload);
      req.end();
    });
  }

  createStreamingPlayer() {
    const platform = process.platform;
    
    try {
      if (platform === "darwin") {
        return spawn("afplay", ["-"], { stdio: ["pipe", "ignore", "pipe"] });
      } else if (platform === "linux") {
        try {
          return spawn("mpv", ["--no-video", "--"], { stdio: ["pipe", "ignore", "pipe"] });
        } catch {
          try {
            return spawn("ffplay", ["-nodisp", "-autoexit", "-"], { stdio: ["pipe", "ignore", "pipe"] });
          } catch {
            return null;
          }
        }
      } else if (platform === "win32") {
        try {
          return spawn("ffplay", ["-nodisp", "-autoexit", "-"], { stdio: ["pipe", "ignore", "pipe"] });
        } catch {
          return null;
        }
      }
    } catch (error) {
      return null;
    }
    
    return null;
  }

  async playAudioFile(filePath) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(filePath)) {
        reject(new Error(`Audio file not found: ${filePath}`));
        return;
      }

      const platform = process.platform;
      let command, args;

      this.log(`Playing audio file: ${filePath}`);

      if (platform === "darwin") {
        command = "afplay";
        args = [filePath];
      } else if (platform === "linux") {
        const players = [
          { cmd: "mpv", args: ["--no-video", filePath] },
          { cmd: "ffplay", args: ["-nodisp", "-autoexit", filePath] },
          { cmd: "aplay", args: [filePath] }
        ];
        
        for (const player of players) {
          try {
            const child = spawn(player.cmd, player.args, { stdio: "ignore" });
            child.on("close", resolve);
            child.on("error", () => {});
            return;
          } catch {}
        }
        
        reject(new Error("No suitable audio player found"));
        return;
      } else if (platform === "win32") {
        command = "ffplay";
        args = ["-nodisp", "-autoexit", filePath];
      } else {
        reject(new Error(`Unsupported platform: ${platform}`));
        return;
      }

      const audioProcess = spawn(command, args, { stdio: "ignore" });
      
      audioProcess.on("close", (code) => {
        if (code === 0) {
          this.log("Audio playback completed");
          resolve();
        } else {
          reject(new Error(`Audio player exited with code ${code}`));
        }
      });

      audioProcess.on("error", (error) => {
        reject(new Error(`Failed to start audio player: ${error.message}`));
      });
    });
  }
}

// Command line argument parsing
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    stream: false,
    save: true,
    cleanup: true,
    output: "output.mp3",
    model: "aura-2-thalia-en",
    verbose: false,
    apiKey: null,
    text: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '-h':
      case '--help':
        showHelp();
        process.exit(0);
        break;
        
      case '-s':
      case '--stream':
        options.stream = true;
        break;
        
      case '--no-save':
        options.save = false;
        break;
        
      case '--no-cleanup':
        options.cleanup = false;
        break;
        
      case '-o':
      case '--output':
        options.output = args[++i];
        break;
        
      case '-m':
      case '--model':
        options.model = args[++i];
        break;
        
      case '-v':
      case '--verbose':
        options.verbose = true;
        break;
        
      case '-k':
      case '--api-key':
        options.apiKey = args[++i];
        break;
        
      case '-t':
      case '--text':
        options.text = args[++i];
        break;
        
      default:
        // If it doesn't start with -, treat it as text
        if (!arg.startsWith('-')) {
          options.text = args.slice(i).join(' ');
          break;
        }
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Deepgram Text-to-Speech Command Line Tool

Usage: node deepgram-tts.js [options] <text>
   or: deepgram-tts [options] <text>

Options:
  -h, --help              Show this help message
  -s, --stream            Use real-time streaming playback (default: download then play)
  -t, --text <text>       Text to convert to speech (can also be passed as argument)
  -o, --output <file>     Output file path (default: output.mp3)
  -m, --model <model>     Deepgram model to use (default: aura-2-thalia-en)
  -k, --api-key <key>     Deepgram API key (or set DEEPGRAM_API_KEY env var)
  -v, --verbose           Enable verbose output
  --no-save               Don't save audio to file (streaming only)
  --no-cleanup            Keep the audio file after playing

Environment Variables:
  DEEPGRAM_API_KEY        Your Deepgram API key

Examples:
  # Basic usage
  deepgram-tts "Hello world"
  
  # Real-time streaming
  deepgram-tts --stream "Hello world"
  
  # Save to custom file
  deepgram-tts -o greeting.mp3 "Hello there!"
  
  # Use different model
  deepgram-tts -m aura-2-luna-en "How are you today?"
  
  # Streaming without saving file
  deepgram-tts --stream --no-save "Quick message"
  
  # With custom API key
  deepgram-tts -k your_api_key "Hello world"

Available Models:
  - aura-2-thalia-en (default, female)
  - aura-2-luna-en (female)
  - aura-2-stella-en (female)
  - aura-2-athena-en (female)
  - aura-2-hera-en (female)
  - aura-2-orion-en (male)
  - aura-2-arcas-en (male)
  - aura-2-perseus-en (male)
  - aura-2-angus-en (male)
  - aura-2-orpheus-en (male)

System Requirements:
  macOS: Built-in afplay (no additional install needed)
  Linux: mpv or ffmpeg (sudo apt install mpv)
  Windows: ffmpeg in PATH (download from ffmpeg.org)
`);
}

// Main execution
async function main() {
  try {
    const options = parseArgs();
    
    // Check if text was provided
    if (!options.text) {
      console.error("Error: No text provided");
      console.log("Use --help for usage information");
      process.exit(1);
    }

    // Create player instance
    const player = new DeepgramTTSPlayer({
      apiKey: options.apiKey,
      saveToFile: options.save,
      playRealTime: options.stream,
      audioFilePath: options.output,
      cleanup: options.cleanup,
      model: options.model,
      verbose: options.verbose
    });

    // Execute based on mode
    if (options.stream) {
      await player.streamAndPlay(options.text);
    } else {
      await player.downloadAndPlay(options.text);
    }

    if (options.verbose) {
      console.log("✅ Completed successfully!");
    }

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = DeepgramTTSPlayer;
