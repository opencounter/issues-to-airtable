const Airtable = require("airtable");
const { Octokit } = require("@octokit/core");
const { paginateRest } = require("@octokit/plugin-paginate-rest");
require("dotenv").config();

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE
)(process.env.AIRTABLE_BASE_NAME);
const octokit = new (Octokit.plugin(paginateRest))({
  auth: process.env.GH_AIRTABLE_SYNC_TOKEN,
});

async function main() {
  const issueNumberToRecord = {};
  await base
    .select({ view: process.env.AIRTABLE_VIEW, fields: ["Number"] })
    .eachPage((records, fetchNextPage) => {
      records.forEach((record) => {
        issueNumberToRecord[record.get("Number")] = record.getId();
      });
      fetchNextPage();
    });
  console.log(
    `Fetched ${Object.keys(issueNumberToRecord).length} records from airtable.`
  );

  const githubIssues = {};
  for await (const response of octokit.paginate.iterator(
    "GET /repos/{owner}/{repo}/issues",
    {
      owner: process.env.GH_OWNER,
      repo: process.env.GH_REPO,
      // labels: ["serve"],
      per_page: 100,
      state: "all",
      pull_request: true,
    }
  )) {
    for (const issue of response.data) {
      githubIssues[issue.number.toString()] = {
        fields: {
          Number: issue.number,
          Title: issue.title,
          Labels: issue.labels.map((label) => label.name),
          Milestone: issue.milestone?.title,
          MilestoneDueDate: issue.milestone?.due_on,
          MilestoneState: issue.milestone?.state,
          Link: issue.html_url,
          CreatedAt: issue.created_at,
          UpdatedAt: issue.updated_at,
          Body: issue.body,
          State: issue.state,
          Assignees: issue.assignees.map((user) => user.login),
          //Priority: issue.labels.filter((label) =>
            //label.name.endsWith(":high")
          //)[0]?.name,
        },
      };
    }
  }
  console.log(`Fetched ${Object.keys(githubIssues).length} issues from github`);

  const airTableNumbers = new Set(Object.keys(issueNumberToRecord));
  const recordToAdd = Object.entries(githubIssues)
    .filter(([number, _]) => !airTableNumbers.has(number))
    .map(([_, record]) => record);
  const recordToUpdate = Object.entries(githubIssues)
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
      id: issueNumberToRecord[record.fields["Number"].toString()],
      fields: record.fields,
    }));
    await base.replace(chunk, {
      typecast: true,
    });
  }

  console.log("Done!");
}

main().then(console.log).catch(console.error);
