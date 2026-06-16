const fs = require("fs");
const { chromium } = require("playwright");

const sharepointUrl = process.env.SHAREPOINT_URL;
const outputFile = process.env.OUTPUT_FILE;

if (!sharepointUrl) {
  throw new Error("Missing SHAREPOINT_URL.");
}

if (!outputFile) {
  throw new Error("Missing OUTPUT_FILE.");
}

function withoutDownloadParam(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete("download");
  return url.toString();
}

function validateDownloadedJson(path) {
  const text = fs.readFileSync(path, "utf8").trim();

  if (!text) {
    throw new Error(`Downloaded file is empty: ${path}`);
  }

  if (
    text.startsWith("<!DOCTYPE") ||
    text.startsWith("<html") ||
    text.includes("<body") ||
    text.includes("Sign in") ||
    text.includes("Access denied")
  ) {
    throw new Error(`Downloaded HTML/login/error page instead of JSON: ${path}`);
  }

  JSON.parse(text);
}

async function saveDownload(download, outputFile) {
  await download.saveAs(outputFile);

  const size = fs.statSync(outputFile).size;
  console.log(`Downloaded ${outputFile}: ${size} bytes`);

  validateDownloadedJson(outputFile);
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 }
  });

  const page = await context.newPage();

  let downloaded = false;

  console.log(`Attempting direct browser download to ${outputFile}`);

  try {
    const downloadPromise = page.waitForEvent("download", { timeout: 45000 });

    await page.goto(sharepointUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }).catch(() => {});

    const download = await downloadPromise;
    await saveDownload(download, outputFile);
    downloaded = true;
  } catch (error) {
    console.log("Direct download did not complete:", error.message);
  }

  if (!downloaded) {
    console.log("Trying SharePoint viewer download button...");

    const viewerUrl = withoutDownloadParam(sharepointUrl);

    await page.goto(viewerUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    const possibleButtons = [
      page.getByRole("button", { name: /download/i }),
      page.locator('[aria-label*="Download"]').first(),
      page.locator('button:has-text("Download")').first(),
      page.locator('a:has-text("Download")').first()
    ];

    for (const locator of possibleButtons) {
      try {
        await locator.waitFor({ state: "visible", timeout: 10000 });

        const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
        await locator.click();

        const download = await downloadPromise;
        await saveDownload(download, outputFile);
        downloaded = true;
        break;
      } catch (error) {
        console.log("Download button attempt failed:", error.message);
      }
    }
  }

  await browser.close();

  if (!downloaded) {
    throw new Error(`Could not download ${outputFile} from SharePoint.`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
