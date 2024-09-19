import subprocess
import re
import argparse

def git_search(search_string, max_results, context_lines):
    commit_hash = ''
    results = []
    
    while len(results) < max_results:
        # Git command to get the diff of the next commit
        git_command = f"git log -n1 --format=%H {commit_hash}".split()
        commit = subprocess.check_output(git_command).decode().strip()
        
        if not commit:
            break  # No more commits
        
        # Get the diff for this commit
        diff_command = f"git show {commit} -U{context_lines}".split()
        diff = subprocess.check_output(diff_command).decode()
        
        # Search for the string in the diff
        matches = re.finditer(f"^(@@.*\n)?([^\n]*{re.escape(search_string)}[^\n]*(\n[^\n]+){{0,{context_lines}}})", diff, re.MULTILINE)
        
        for match in matches:
            file_match = re.search(r"^--- a/(.*)", match.string[:match.start()], re.MULTILINE)
            if file_match:
                filename = file_match.group(1)
                result = f"File: {filename}\nCommit: {commit}\n{match.group()}\n"
                results.append(result)
                
                if len(results) >= max_results:
                    break
        
        commit_hash = f"{commit}^"
    
    return results

def main():
    parser = argparse.ArgumentParser(description="Search for a string in Git commits")
    parser.add_argument("search_string", help="String to search for")
    parser.add_argument("--max-results", type=int, default=10, help="Maximum number of results to return")
    parser.add_argument("--context-lines", type=int, default=3, help="Number of context lines to show")
    
    args = parser.parse_args()
    
    results = git_search(args.search_string, args.max_results, args.context_lines)
    
    for result in results:
        print(result)
        print("-" * 80)

if __name__ == "__main__":
    main()
