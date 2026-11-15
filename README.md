# TalentPulse

Upload your resume, choose your job titles, and TalentPulse shows matching openings from **2,100+ Canadian employers**. For each opening you see its level (new grad / entry level / years asked), where it is (province or remote in Canada), when it was posted, and a button to apply on the employer's own site.

Everything is in this one folder, with no subfolders.

## Set it up (one time)

1. **Upload the files.** In your GitHub repository, click **Add file → Upload files**, drag in **all the files in this folder**, and click **Commit changes**.
2. **Allow the scan to save results.** Go to **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**, and click **Save**.
3. **Turn on the website.** Go to **Settings → Pages**:
   1. Under **Source**, choose **Deploy from a branch**.
   2. Under **Branch**, choose **main** and **/ (root)**.
   3. Click **Save**.
   4. After about a minute the page shows your link, `https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`.
4. **Open your website and click the green "Turn on the daily scan" button** at the top.
   - GitHub opens with the scan settings already filled in. Click **Commit changes**, then **Commit changes** again.
   - GitHub keeps scan settings in a hidden folder that drag-and-drop skips, which is why this one file is created by that button.
   - The first scan starts by itself and takes about **1–2 hours**. The box at the top of your website shows its progress.

After that, the scan runs every morning on its own.

## What the scan does

- **It reads every employer's job board.** It checks every employer in `employers.csv`, all 2,127 of them (71 federal departments that hire through GC Jobs are switched off).
  - About 460 employers came with a direct job-board link.
  - For the others, the scan first tries the major job boards under the company's name.
  - If that fails, it finds the company's **official website**, opens its **careers page**, and works out which job board it uses. That includes Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Workable, SAP SuccessFactors, Oracle, UKG, iCIMS, Taleo, BambooHR, Recruitee and Breezy, or the employer's own job pages.
  - What it finds is remembered, so later scans are faster.
- **It keeps only openings located in Canada or remote.**
- **It records each opening's details:** the posting date, the years of experience asked, and whether it says new grad, entry level, early career, fresher and so on.

The website's **Employers** tab shows the result for each employer. **Needs a careers link** means it couldn't find a readable job list. To fix one:
1. Open `employers.csv` in Excel.
2. Paste that employer's job-list address into the `careers_url` column, save as **CSV UTF-8**, and upload the file again. A new scan starts automatically.

## Experience levels (same rules as the Job Watch desktop app)

| Level | Meaning |
|---|---|
| New grad | Says new grad, graduate program, entry level, junior, early career, fresher, rotational… |
| Entry level | Asks for a number of years within your limit (default 2) |
| Unspecified | No seniority stated (often worth a look) |
| Internship | Intern, co-op, summer student |
| Experienced | Asks for more years than your limit |
| Senior | Senior, Lead, Manager, Director, level II+ |

Your resume and titles stay in your browser; they are never uploaded.
