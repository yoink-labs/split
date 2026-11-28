import type { Content, ContentTable, ContentText, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";

const ink = "#24201b";
const highlight = "#e9f1df";
const muted = "#665e54";

function textRuns(element: HTMLElement): ContentText[] {
  if (element.matches("mark.sum-self")) {
    return [{ text: element.innerText, bold: true, color: "#233b28", background: "#e1edd7" }];
  }
  if (!element.querySelector("mark.sum-self")) return [{ text: element.innerText.trim() }];

  // Keep the marked member's identity without highlighting other people who have the same name.
  return Array.from(element.childNodes).flatMap((child): ContentText[] => {
    if (child.nodeType === Node.TEXT_NODE) return [{ text: child.textContent ?? "" }];
    if (!(child instanceof HTMLElement)) return [];
    const runs = textRuns(child);
    const block = ["block", "flex", "grid"].includes(getComputedStyle(child).display);
    return block && child.previousSibling ? [{ text: "\n" }, ...runs] : runs;
  });
}

function amountLines(element: HTMLElement, fontSize: number): ContentText[] {
  return element.innerText.trim().split("\n").map((text, index) => ({
    text,
    fontSize: index === 0 ? fontSize : 8,
    color: index === 0 ? ink : muted,
  }));
}

function tableBlock(table: HTMLTableElement): ContentTable | undefined {
  const rows = Array.from(table.rows);
  if (!rows.length || !rows[0].cells.length) return;
  const itemized = table.classList.contains("sum-items");
  const headerRows = table.tHead?.rows.length ?? 0;
  const columns = Array.from(table.querySelectorAll(":scope > colgroup > col"));
  const widths = Array.from(rows[0].cells, (_, i) => {
    const column = columns[i];
    if (column?.classList.contains("c-date")) return "16%";
    if (column?.classList.contains("c-wide")) return "38%";
    if (column?.classList.contains("c-name")) return "28%";
    return "*";
  });

  return {
    layout: "lightHorizontalLines",
    margin: [0, 2, 0, 9],
    table: {
      widths,
      headerRows,
      keepWithHeaderRows: !itemized && headerRows > 0 && rows.length > headerRows ? 1 : 0,
      dontBreakRows: !itemized,
      body: rows.map((row) => Array.from(row.cells, (cell): TableCell => {
        // Item and person rows that head a group of portion lines are bold on a light wash.
        const subhead = row.classList.contains("sum-subhead");
        const fill = row.closest(".sum-involved") ? { fillColor: highlight } : subhead && !itemized ? { fillColor: "#f4f1ec" } : {};
        const indent = cell.querySelector(":scope > .sum-indent") ? 12 : 0;
        const claims = Array.from(cell.querySelectorAll(".sum-claims > li"), (claim, index) => {
          const [person, amount] = Array.from(claim.children) as HTMLElement[];
          return [
            { text: index ? "\n" : "" },
            ...textRuns(person),
            { text: "  " + amount.innerText.trim() },
          ];
        });
        if (cell.classList.contains("r") && cell.tagName !== "TH") {
          return {
            stack: amountLines(cell, 9).map((line, index) => (index === 0 && subhead ? { ...line, bold: true } : line)),
            alignment: "right",
            margin: [0, subhead ? 4 : 3],
            ...fill,
          };
        }
        return {
          text: claims.length > 0 ? claims.flat() : textRuns(cell),
          alignment: cell.classList.contains("r") ? "right" : "left",
          fontSize: 9,
          bold: cell.tagName === "TH" || subhead,
          color: cell.tagName === "TH" ? muted : ink,
          wordBreak: "break-all",
          margin: [indent, subhead ? 4 : 3, 0, subhead ? 4 : 3],
          ...fill,
        };
      })),
    },
  };
}

function blocks(element: Element): Content[] {
  if (!(element instanceof HTMLElement)) return [];
  if (element instanceof HTMLTableElement) {
    const table = tableBlock(element);
    return table ? [table] : [];
  }

  const children = () => Array.from(element.children).flatMap(blocks);
  if (element.matches("article, section, header, footer, .sum-receipt")) return children();
  if (element.matches(".sum-entry")) return [{ stack: children(), margin: [0, 6, 0, 5] }];

  if (element.matches(".sum-meta")) {
    const details = Array.from(element.children, (pair) => {
      const label = pair.querySelector("dt")?.textContent;
      const value = pair.querySelector("dd")?.textContent;
      return `${label} ${value}`;
    });
    return [{ text: details.join("  ·  "), color: muted, fontSize: 9, margin: [0, 3, 0, 10] }];
  }

  if (element.matches(".sum-figures, .sum-entry-head")) {
    const figures = element.matches(".sum-figures");
    const columns = Array.from(element.children, (child, index) => {
      if (!figures && index === 2) {
        return { stack: amountLines(child as HTMLElement, 10), width: 124, alignment: "right" as const };
      }
      return {
        text: textRuns(child as HTMLElement),
        width: figures || index === 1 ? "*" : 76,
        fontSize: figures || index !== 0 ? 10 : 9,

      };
    });
    if (element.closest(".sum-involved")) {
      return [{
        layout: "noBorders",
        headlineLevel: 2,
        table: {
          widths: [76, "*", 124],
          dontBreakRows: true,
          body: [columns.map((column) => ({ ...column, width: undefined, fillColor: highlight, margin: [3, 4, 3, 4] }))],
        },
        margin: [0, 0, 0, 3],
      }];
    }
    return [{ columns, unbreakable: !figures, columnGap: 10, margin: [0, 0, 0, 7] }];
  }

  if (!element.innerText.trim()) return [];
  const text = textRuns(element);
  if (element.matches("h1")) return [{ text, fontSize: 26, bold: true, margin: [0, 0, 0, 5] }];
  if (element.matches("h2")) return [{ text, fontSize: 14, bold: true, headlineLevel: 1, margin: [0, 9, 0, 4] }];
  if (element.matches(".sum-kicker, .sum-small, .sum-fine, .sum-entry-fx, .sum-foot-row")) {
    return [{ text, fontSize: 9, color: muted, margin: [0, 0, 0, 5] }];
  }
  return [{ text, margin: [0, 0, 0, 6] }];
}

/** Take the contents from the current report so PDF amounts and rows match the selected view. */
export async function downloadReportPDF(report: HTMLElement, title: string) {
  const definition: TDocumentDefinitions = {
    info: { title, creator: "Split" },
    pageSize: "LETTER",
    pageMargins: [40, 42, 40, 44],
    defaultStyle: { fontSize: 10, color: ink },
    content: blocks(report),
    footer: (page, total) => ({
      text: `${page} / ${total}`,
      alignment: "right",
      margin: [40, 10, 40, 0],
      fontSize: 8,
      color: muted,
    }),
    pageBreakBefore: (block, following) => {
      if (block.headlineLevel === 1) return following.getFollowingNodesOnPage().length === 0;
      if (block.headlineLevel === 2) {
        return !following.getFollowingNodesOnPage().some((node) => node.table);
      }
      return false;
    },
  };
  const [{ default: pdfMake }, { default: fonts }] = await Promise.all([
    import("pdfmake/build/pdfmake"),
    import("pdfmake/build/vfs_fonts"),
  ]);
  pdfMake.addVirtualFileSystem(fonts);
  const filename = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  await pdfMake.createPdf(definition).download(`${filename}.pdf`);
}
