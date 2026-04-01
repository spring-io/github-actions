const core = require('@actions/core')
const github = require('@actions/github')
const Mustache = require('mustache')
const fs = require('fs')
const path = require('path')

// Built-in partials — no leading indentation; Mustache prepends the call-site whitespace to every line.
// e.g. a template line "    {{>schedule}}" (4-space indent) produces:
//   "    schedule:\n      interval: weekly"
// Each partial ends with \n so that when used as a standalone partial tag (which consumes
// the tag's own trailing newline), the partial's own trailing newline keeps the next
// template line on a fresh line, preserving standalone detection for tags that follow.
const PARTIALS = {
  'target-branch': 'target-branch: {{branch}}\n',
  directory: 'directory: /\n',
  schedule: 'schedule:\n  interval: weekly\n',
  labels: "labels:\n  - 'in: build'\n  - 'type: dependency-upgrade'\n",
}

async function run() {
  try {
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
    const { repo: { owner, repo: repoName } } = github.context

    const token = core.getInput('token') || process.env.GITHUB_TOKEN
    const isCommercialName = repoName.endsWith('-commercial')
    const projectSlug = core.getInput('project-slug') || repoName.replace(/-commercial$/, '')
    const projectTypeInput = core.getInput('project-type')
    const projectType = projectTypeInput || (isCommercialName ? 'commercial' : 'oss')
    core.info(`Project: ${projectSlug} (${projectType})`)

    // Normalize today to midnight UTC for clean date boundary comparisons against YYYY-MM-DD API values
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    const generations = await fetchGenerations(projectSlug)
    core.info(`Fetched ${generations.length} generations`)

    const featureBranchNames = generations
      .filter(g => isActiveGeneration(g, projectType, today))
      .map(g => g.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

    core.info(`Active feature branches: ${featureBranchNames.join(', ')}`)

    const octokit = github.getOctokit(token)
    const milestones = await fetchMilestones(octokit, owner, repoName)
    core.info(`Fetched ${milestones.length} open milestones`)

    // Build feature-branches context; milestone is only set when a matching one is found
    const featureBranchEntries = featureBranchNames.map(name => {
      const entry = { branch: name }
      const num = findMilestoneNumber(milestones, name)
      if (num !== undefined) entry.milestone = num
      return entry
    })

    // Assemble context; main is OSS-only — omitting the key causes {{#main}}...{{/main}} to render nothing
    const context = {
      'feature-branches': featureBranchEntries,
      'docs-build': { branch: 'docs-build' },
    }

    if (projectType === 'oss') {
      const mainEntry = { branch: 'main' }
      const mainMilestone = await resolveMainMilestone(
        generations, featureBranchNames, milestones, workspace
      )
      if (mainMilestone !== undefined) {
        mainEntry.milestone = mainMilestone
        core.info(`Main milestone: #${mainMilestone}`)
      } else {
        core.info('No main milestone found; omitting milestone property for main')
      }
      context.main = mainEntry
    }

    core.debug(`Mustache context:\n${JSON.stringify(context, null, 2)}`)

    const specPath = path.join(workspace, '.github', 'specs', 'dependabot.spec.yml')
    if (!fs.existsSync(specPath)) {
      throw new Error(`Spec template not found: ${specPath}`)
    }
    const template = fs.readFileSync(specPath, 'utf8')

    const rendered = Mustache.render(template, context, PARTIALS)

    const outputPath = path.join(workspace, '.github', 'dependabot.yml')
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, rendered, 'utf8')
    core.info(`Wrote ${outputPath}`)
  } catch (error) {
    core.setFailed(error.message)
  }
}

async function fetchGenerations(slug) {
  const response = await fetch(`https://api.spring.io/projects/${slug}/generations`)
  if (response.status === 404) {
    core.info(`Project '${slug}' not found in Spring API; no feature branches will be included`)
    return []
  }
  if (!response.ok) {
    throw new Error(`Generations API returned ${response.status} for slug '${slug}'`)
  }
  const data = await response.json()
  return data._embedded?.generations ?? []
}

// A generation is active when today falls within its supported date range.
// OSS:        initialReleaseDate <= today <= ossSupportEndDate
// Commercial: today > ossSupportEndDate AND today <= commercialSupportEndDate
function isActiveGeneration(generation, projectType, today) {
  const initial = new Date(generation.initialReleaseDate)
  const ossEnd = new Date(generation.ossSupportEndDate)
  const commercialEnd = new Date(generation.commercialSupportEndDate)
  if (projectType === 'oss') {
    return initial <= today && today <= ossEnd
  }
  return today > ossEnd && today <= commercialEnd
}

// Paginates the GitHub milestones API, returning all open milestones.
async function fetchMilestones(octokit, owner, repo) {
  const milestones = []
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.issues.listMilestones({
      owner, repo, state: 'open', per_page: 100, page,
    })
    milestones.push(...data)
    if (data.length < 100) break
  }
  return milestones
}

// Returns the milestone number for an exact title match, or undefined if not found.
function findMilestoneNumber(milestones, name) {
  const m = milestones.find(m => m.title === name)
  return m ? m.number : undefined
}

// Sorts all generations descending by version and returns the name of the first
// that is not already an active feature branch — this is the generation main tracks.
function findMainGeneration(generations, featureBranchNames) {
  const featureSet = new Set(featureBranchNames)
  return [...generations]
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    .find(g => !featureSet.has(g.name))
    ?.name ?? null
}

// Reads the project version from pom.xml or gradle.properties and converts to a
// branch name by stripping pre-release suffixes and taking major.minor.x.
// e.g. '7.1.2-SNAPSHOT' -> '7.1.x', '6.5.0-M1' -> '6.5.x'
function readProjectVersion(workspace) {
  const pomPath = path.join(workspace, 'pom.xml')
  if (fs.existsSync(pomPath)) {
    const match = fs.readFileSync(pomPath, 'utf8').replace(/<parent>[\s\S]*?<\/parent>/, '').match(/<version>([^<]+)<\/version>/)
    if (match) return match[1].trim()
  }
  const propsPath = path.join(workspace, 'gradle.properties')
  if (fs.existsSync(propsPath)) {
    const match = fs.readFileSync(propsPath, 'utf8').match(/^version\s*=\s*(.+)$/m)
    if (match) return match[1].trim()
  }
  return null
}

function toVersionBranch(version) {
  const base = version.split('-')[0]
  const [major, minor] = base.split('.')
  return `${major}.${minor}.x`
}

// Resolves the milestone number for the main branch using a two-step fallback chain:
// 1. Latest generation in the API not already a feature branch (what main is tracking)
// 2. Project version from pom.xml / gradle.properties converted to major.minor.x
async function resolveMainMilestone(generations, featureBranchNames, milestones, workspace) {
  const mainGenName = findMainGeneration(generations, featureBranchNames)
  if (mainGenName) {
    const num = findMilestoneNumber(milestones, mainGenName)
    if (num !== undefined) {
      core.info(`Resolved main generation from API: ${mainGenName}`)
      return num
    }
  }

  const version = readProjectVersion(workspace)
  if (version) {
    const branch = toVersionBranch(version)
    core.info(`Resolved main branch from build files: ${version} → ${branch}`)
    const num = findMilestoneNumber(milestones, branch)
    if (num !== undefined) return num
  }

  return undefined
}

module.exports = {
  run,
  fetchGenerations,
  isActiveGeneration,
  fetchMilestones,
  findMilestoneNumber,
  findMainGeneration,
  readProjectVersion,
  toVersionBranch,
  resolveMainMilestone,
}
