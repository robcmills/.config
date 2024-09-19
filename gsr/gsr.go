package main

import (
    "bufio"
    "bytes"
    "flag"
    "fmt"
    "os"
    "os/exec"
    "strings"
)

type Match struct {
    FileName      string
    CommitHash    string
    CommitAuthor  string
    CommitDate    string
    CommitMessage string
    Context       string
}

func main() {
    // Command-line flags
    searchString := flag.String("search", "", "String to search for")
    maxMatches := flag.Int("max-matches", 10, "Maximum number of matches to find")
    maxCommits := flag.Int("max-commits", 100, "Maximum number of commits to search")
    contextLines := flag.Int("context", 3, "Number of context lines to show")
    showCommitInfo := flag.Bool("show-commit-info", true, "Whether to show commit information")
    flag.Parse()

    if *searchString == "" {
        fmt.Println("Please provide a search string using the -search flag.")
        os.Exit(1)
    }

    // Build the git command
    gitArgs := []string{
        "log",
        fmt.Sprintf("-G%s", *searchString),
        fmt.Sprintf("-n%d", *maxCommits),
        "-p",
        fmt.Sprintf("-U%d", *contextLines),
        `--format=---commit---
%H
%an
%ad
%s
`,
    }
    // Log the command being executed
    fmt.Println("Executing git command:", "git", gitArgs)

    cmd := exec.Command("git", gitArgs...)
    output, err := cmd.Output()
    if err != nil {
        fmt.Println("Error executing git command:", err)
        os.Exit(1)
    }

    // Parse the output
    matches := parseGitOutput(output, *searchString, *maxMatches)

    // Display the results
    for _, match := range matches {
        fmt.Println("File:", match.FileName)
        fmt.Println("Context:\n", match.Context)
        if *showCommitInfo {
            fmt.Println("Commit Hash:", match.CommitHash)
            fmt.Println("Author:", match.CommitAuthor)
            fmt.Println("Date:", match.CommitDate)
            fmt.Println("Message:", match.CommitMessage)
        }
        fmt.Println("--------------------------------------------------")
    }
}

// Function to parse git output and extract matches
func parseGitOutput(output []byte, searchString string, maxMatches int) []Match {
    scanner := bufio.NewScanner(bytes.NewReader(output))
    var matches []Match
    var currentMatch Match
    collectingDiff := false
    diffBuffer := new(bytes.Buffer)
    matchCount := 0

    for scanner.Scan() {
        line := scanner.Text()
        if line == "---commit---" {
            if matchCount >= maxMatches {
                break
            }
            // Save the previous match if any
            if collectingDiff && diffBuffer.Len() > 0 {
                currentMatch.Context = diffBuffer.String()
                matches = append(matches, currentMatch)
                matchCount++
                diffBuffer.Reset()
            }
            // Start a new match
            currentMatch = Match{}
            collectingDiff = false
            // Read commit info
            scanner.Scan()
            currentMatch.CommitHash = scanner.Text()
            scanner.Scan()
            currentMatch.CommitAuthor = scanner.Text()
            scanner.Scan()
            currentMatch.CommitDate = scanner.Text()
            scanner.Scan()
            currentMatch.CommitMessage = scanner.Text()
        } else if strings.HasPrefix(line, "diff --git") {
            // Extract file name
            parts := strings.Split(line, " ")
            if len(parts) >= 3 {
                currentMatch.FileName = strings.TrimPrefix(parts[2], "a/")
            }
        } else if strings.HasPrefix(line, "@@") {
            collectingDiff = true
            diffBuffer.WriteString(line + "\n")
        } else if collectingDiff {
            diffBuffer.WriteString(line + "\n")
        }
    }

    // Handle the last match
    if collectingDiff && diffBuffer.Len() > 0 && matchCount < maxMatches {
        currentMatch.Context = diffBuffer.String()
        matches = append(matches, currentMatch)
    }

    return matches
}
