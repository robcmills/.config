import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface SearchResult {
  filename: string;
  commit: string;
  match: string;
}

async function gitSearch(searchString: string, maxResults: number, contextLines: number): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  let commitHash = '';

  while (results.length < maxResults) {
    // Get the next commit
    const { stdout: commit } = await execAsync(`git log -n1 --format=%H ${commitHash}`);
    if (!commit.trim()) break; // No more commits

    // Get the diff for this commit
    const { stdout: diff } = await execAsync(`git show ${commit.trim()} -U${contextLines}`);

    // Search for the string in the diff
    const regex = new RegExp(`^(@@.*\\n)?(.*${searchString}.*(?:\\n.+){0,${contextLines}})`, 'gim');
    const matches = diff.matchAll(regex);

    for (const match of Array.from(matches)) {
      const fileMatch = diff.slice(0, match.index).match(/^--- a\/(.*)/m);
      if (fileMatch) {
        const filename = fileMatch[1];
        results.push({
          filename,
          commit: commit.trim(),
          match: match[0],
        });

        if (results.length >= maxResults) break;
      }
    }

    commitHash = `${commit.trim()}^`;
  }

  return results;
}

function parseArgs(): { searchString: string; maxResults: number; contextLines: number } {
  const args = process.argv.slice(2);
  let searchString = '';
  let maxResults = 10;
  let contextLines = 3;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-m':
      case '--max-results':
        maxResults = parseInt(args[++i], 10);
        break;
      case '-c':
      case '--context-lines':
        contextLines = parseInt(args[++i], 10);
        break;
      default:
        if (!searchString) searchString = args[i];
        break;
    }
  }

  if (!searchString) {
    console.error('Error: Search string is required.');
    process.exit(1);
  }

  return { searchString, maxResults, contextLines };
}

async function main() {
  const { searchString, maxResults, contextLines } = parseArgs();

  try {
    const results = await gitSearch(searchString, maxResults, contextLines);

    results.forEach((result, index) => {
      console.log(`File: ${result.filename}`);
      console.log(`Commit: ${result.commit}`);
      console.log(result.match);
      if (index < results.length - 1) {
        console.log('-'.repeat(80));
      }
    });
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

main();
