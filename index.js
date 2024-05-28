require("util").inspect.defaultOptions.depth = 4;

const Airtable = require("airtable");
const { graphql } = require("@octokit/graphql");
require("dotenv").config();

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE
)(process.env.AIRTABLE_BASE_NAME);

const octokit = graphql.defaults({
  headers: {
    authorization: `Bearer ${process.env.GH_AIRTABLE_SYNC_TOKEN}`,
    // https://docs.github.com/en/graphql/overview/schema-previews#project-event-details-preview
    accept: "application/vnd.github.starfox-preview+json",
  },
});

const GH_QUERY_NODES = `
  number
  title
  createdAt
  updatedAt
  url
  body
  state
  milestone {
    title
    state
    dueOn
  }
  assignees(first: 10) {
    nodes {
      login
    }
  }
  labels(first: 100) {
    nodes {
      name
    }
  }
  projectCards {
    nodes {
      project {
        name
      }
      column {
        name
      }
    }
  }
`;

const getGHQuery = (year) => {
  return `
    query repoIssues($cursor: String) {
      search(
        query: "created:${year}-01-01..${year}-12-31 repo:${process.env.GH_OWNER}/${process.env.GH_REPO}",
        type: ISSUE,
        first: 100,
        after: $cursor
      ) {
        pageInfo {
          endCursor
          hasNextPage
        }

        nodes {
          ... on Issue {
            ${GH_QUERY_NODES}
          }
          ... on PullRequest {
            ${GH_QUERY_NODES}
          }
        }
      }
    }
  `
};

const GH_QUERY_VARS = {
  owner: process.env.GH_OWNER,
  repo: process.env.GH_REPO,
};

// Recursive fn to handle pagination
async function fetchIssuesForYear({ issues, cursor, year })  {
  issues ||= []
  const { search } = await octokit(getGHQuery(year), { cursor, ...GH_QUERY_VARS });
  issues.push(...search.nodes);
  if (search.pageInfo.hasNextPage) {
    await fetchIssuesForYear({ issues, year, cursor: search.pageInfo.endCursor });
  }
  return issues;
};

async function fetchIssues() {
  let allIssues = []
  years = generateYearsBetween(2013, new Date().getFullYear());
  for (const year of years) {
    let issues = await fetchIssuesForYear({ year })
    allIssues.push(issues)
    console.log(year + ": " + issues.length + " issues fetched from GitHub")
  }
  return allIssues.flat(Infinity);
}

async function fetchRecords() {
  const recordsByIssueNumber = {};
  await base
    .select({ fields: ["Number"] })
    .eachPage((records, fetchNextPage) => {
      records.forEach((record) => {
        recordsByIssueNumber[record.get("Number")] = record.getId();
      });
      fetchNextPage();
    });
  return recordsByIssueNumber;
}

const getColumnName = (issue, projectName) =>
  issue.projectCards?.nodes.find(
    (card) => card.project.name == projectName
  )?.column?.name;

const ENGINEERS = ["joshuabates", "jneen", "rtlong", "davidhampgonsalves", "sashadarling"]
const getEngineer = (issue) =>
  issue.assignees.nodes.find((user) =>
    ENGINEERS.includes(user.login))?.login

function generateYearsBetween(startYear, endYear) {
  let years = [];
  for (var i = startYear; i <= endYear; i++) {
    years.push(startYear);
    startYear++;
  }
  return years;
}


const transformIssues = (issues) => {
  const PRODUCT_PROJECT = "OpenCounter: Product Backlog";
  const ENG_PROJECT = "OpenCounter: Engineering Sprints";

  transformed = {};
  for (const issue of issues) {
    try {
      const labels = []
      const themes = []
      const initiatives = []
      const customers = []
      const priorities = []

      for (const label of issue.labels.nodes) {
        theme = label.name.split("theme:", 2)[1]
        initiative = label.name.split("initiative:", 2)[1]
        customer = label.name.split("feedback:", 2)[1]
        priority = label.name.split("p:", 2)[1]

        if (theme) {
          themes.push(theme);
        } else if (initiative) {
          initiatives.push(initiative);
        } else if (customer) {
          customers.push(customer);
        } else if (priority) {
          priorities.push(priority);
        } else {
          labels.push(label.name);
        }
      }

      transformed[issue.number.toString()] = {
        fields: {
          Number: issue.number,
          Title: `OC${issue.number}: ${issue.title}`,
          CreatedAt: issue.createdAt,
          UpdatedAt: issue.updatedAt,
          Link: issue.url,
          Body: issue.body,
          State: issue.state,
          Milestone: issue.milestone?.title,
          MilestoneState: issue.milestone?.state,
          MilestoneDueDate: issue.milestone?.dueOn,
          Assignees: issue.assignees.nodes.map((user) => user.login),
          Engineer: getEngineer(issue),
          ProductState: getColumnName(issue, PRODUCT_PROJECT),
          EngineeringState: getColumnName(issue, ENG_PROJECT),
          Labels: labels,
          Customers: customers,
          Theme: themes[0], // one per issue
          Initiative: initiatives[0], // one per issue
          BugSeverity: priorities[0], // one per issue
        },
      };
    } catch(e) {
      console.error("Error processing issue:", issue);
      throw(e);
    }
  }
  return transformed;
};

async function updateRecordsWithIssues(recordsByIssueNumber, updatedRecords) {
  const airTableNumbers = new Set(Object.keys(recordsByIssueNumber));
  const recordToAdd = Object.entries(updatedRecords)
    .filter(([number, _]) => !airTableNumbers.has(number))
    .map(([_, record]) => record);
  const recordToUpdate = Object.entries(updatedRecords)
    .filter(([number, _]) => airTableNumbers.has(number))
    .map(([_, record]) => record);

  console.log(`Adding ${recordToAdd.length} records`);
  for (let i = 0; i < recordToAdd.length; i += 10) {
    const chunk = recordToAdd.slice(i, i + 10);
    await base.create(chunk, {
      typecast: true,
    });
  }

  console.log(`Updating ${recordToUpdate.length} records`);
  for (let i = 0; i < recordToUpdate.length; i += 10) {
    const chunk = recordToUpdate.slice(i, i + 10).map((record) => ({
      id: recordsByIssueNumber[record.fields["Number"].toString()],
      fields: record.fields,
    }));
    await base.replace(chunk, {
      typecast: true,
    });
  }
}

async function main() {
  const [recordsByIssueNumber, issues] = await Promise.all([
    fetchRecords(),
    fetchIssues(),
  ]);
  console.log(
    `Fetched ${Object.keys(recordsByIssueNumber).length} records from airtable.`
  );
  console.log(`Fetched ${Object.keys(issues).length} total issues from github`);

  const updatedRecords = transformIssues(issues);

  await updateRecordsWithIssues(recordsByIssueNumber, updatedRecords);

  return "Done!";
}

main().then(console.log).catch(console.error);
