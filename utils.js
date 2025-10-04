const fs = require("fs");
// const { HttpProxyAgent, HttpsProxyAgent } = require("hpagent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");
const https = require("https");
const http = require("http");
const assert = require("assert");
const path = require("path");
const uiapi = require("../../ui/api");
const sitescriptsolver = require("./sitejs");
const { dynamicevaluator } = require("./dynamicevaluator");

if (!process.captcha_comm_agent) {
  process.captcha_comm_agent = new http.Agent({
    keepAlive: false,
    maxFreeSockets: parseInt(process.env.CAPTCHA_AGENT_MAX_FREE_SOCKETS),
    maxTotalSockets: parseInt(process.env.CAPTCHA_AGENT_MAX_TOTAL_SOCKETS),
    maxSockets: parseInt(process.env.CAPTCHA_AGENT_MAX_SOCKETS),
  });

  process.captcha_comm_agents = new https.Agent({
    keepAlive: false,
    maxFreeSockets: parseInt(process.env.CAPTCHA_AGENT_MAX_FREE_SOCKETS),
    maxTotalSockets: parseInt(process.env.CAPTCHA_AGENT_MAX_TOTAL_SOCKETS),
    maxSockets: parseInt(process.env.CAPTCHA_AGENT_MAX_SOCKETS),
  });
}

let Regexes, CaptchaSolver, Captcha, LoginSolver, VTSolver, CalendarSolver;

VTSolver = class {
  static async solve(html) {
    let r = html.split("MAIN CONTENT START")[1];

    let cssBlockMatch = (r.match(/<style>([\s\S]{100,}?)<\/style>/s) || [""])[1].split("<style>");
    let cssBlock = cssBlockMatch[1] || cssBlockMatch[0];
    let ruleMatch = cssBlock.match(/\.([a-zA-Z0-9]+)\{([\s\S]*?)\}/g) || [""];
    let sitescript_mapping = {};

    if (process.vars.ENABLE_SITEJS == "1") {
      sitescript_mapping = sitescriptsolver.solve(fs.readFileSync(path.resolve(__dirname, "sitejs." + process.vars.COUNTRY + ".js")).toString());
    } else if (process.vars.ENABLE_SITEJS == "2") {
      let sitescript_mapping_string = await dynamicevaluator(html).catch((e) => {
        console.log(e);
        return null;
      });
      if (sitescript_mapping_string === null) throw new Error("can't run dynamicevaluator");
      else if (!sitescript_mapping_string) {
        throw new Error("dynamicevaluator failed");
      } else {
        try {
          console.log(sitescript_mapping_string);
          sitescript_mapping = JSON.parse(sitescript_mapping_string);
        } catch (e) {
          console.log(sitescript_mapping_string);
          throw new Error("dynamicevaluator bad return");
        }
      }
    }

    let sitescript_impact = [];
    let sitescript_impact2 = false;
    if (process.vars.ENABLE_SITEJS == "1") {
      sitescript_impact = [...html.matchAll(new RegExp("(?:" + Object.keys(sitescript_mapping).join("|") + ")([^;]+?);", "g"))].map((m) => {
        return {
          fct: m[0].split("(")[0],
          id: m[0].match(/#(?:div-)?(.+?)\b/)[1],
        };
      });
    } else if (process.vars.ENABLE_SITEJS == "2") {
      sitescript_impact2 = true;
    }

    let rules = ruleMatch
      .map((rule) => {
        let [selector, props] = rule.split("{");
        selector = selector.replace(".", "");
        const propsObj = props
          .replace("}", "")
          .split(";")
          .filter((prop) => prop.trim())
          .map((prop) => prop.trim())
          .reduce((acc, prop) => {
            const [key, value] = prop.split(":").map((prop) => prop.trim());
            acc[key] = value.replace("!important", "").trim();
            return acc;
          }, {});
        return { selector, propsObj };
      })
      .reduce((acc, rule) => {
        acc[rule.selector] = rule.propsObj;
        return acc;
      }, {});

    let elmentmatcher = /<div *class=['"]mb-3 ([^'"]+).+?<label[^>]+for=['"]([^'"]+)['"][^>]*>([^<]+)/gis;

    let elements = [];
    let match;
    while ((match = elmentmatcher.exec(r))) {
      elements.push({
        id: match[2],
        classes: match[1],
        label: match[3],
      });
    }

    let rspdids = [...findFunctionBodyInHTML(r, "OnSubmitVisaType").matchAll(/\b(\w+)\s*:\s*\$\(\s*['"]#(\w+)['"]\s*\)/gis)].map((m) => {
      return {
        key: m[1],
        id: m[2],
      };
    });

    let inputBlocks = [];
    let anIds = [];
    let afIds = [];
    elements.forEach((block) => {
      let classes = block.classes?.split(/\s+/).filter((prop) => prop.trim());

      let style = classes.reduce((acc, className) => {
        let rule = rules[className];
        if (rule) {
          acc = { ...acc, ...rule };
        }
        return acc;
      }, {});

      let sitescript_impact_onthis = "";
      for (const impact of sitescript_impact) {
        if (impact.id === block.id) {
          if (sitescript_mapping[impact.fct]) {
            sitescript_impact_onthis = sitescript_mapping[impact.fct];
          }
        }
      }

      if (sitescript_impact2) {
        for (const siteaction of sitescript_mapping) {
          for (const className of classes) {
            if (siteaction.className === className) {
              sitescript_impact_onthis = siteaction.action;
            }
          }
        }
      }

      if (block.label?.toLowerCase().includes("members")) anIds.push(block.id);
      if (block.label?.toLowerCase().includes("t for") || block.label?.toLowerCase().includes("individ") || block.label?.toLowerCase().includes("family")) afIds.push(block.id);

      if (style["display"] === "none" && sitescript_impact_onthis !== "show") return;
      if (sitescript_impact_onthis === "hide") return;

      inputBlocks.push({
        id: block.id,
        label: block.label,
      });
    });

    let realInputBlocks = inputBlocks.reduce((acc, block) => {
      block.label = block.label.trim();
      let txt = block.label.toLowerCase();
      let trg;

      if (txt.includes("location")) trg = "location";
      else if (txt.match(/sub ?type/)) trg = "visasubtype";
      else if (txt.match(/visa ?type/)) trg = "visatype";
      else if (txt.includes("category")) trg = "category";
      else if (txt.includes("t for") || txt.includes("individual") || txt.includes("family")) trg = "appnfor";
      else if (txt.includes("members")) trg = "applicantsno";
      else if (txt.includes("mission")) trg = "mission";

      acc[trg] = block;
      return acc;
    }, {});

    const realInputBlocksALL = JSON.parse(JSON.stringify(realInputBlocks));
    for (const k of Object.keys(realInputBlocks)) {
      if (!rspdids.some((r) => r.id === realInputBlocks[k].id)) delete realInputBlocks[k];
    }

    let appforarr = [];
    if (process.vars.ENABLE_SITEJS == "2" || process.vars.COUNTRY === "moroccopt") {
      let appformatches = html.match(/<input [^>]+?value="Individual"[^>]+?>/gms);
      for (const appformatch of appformatches) {
        appforarr.push(appformatch.match(/name=['"](.+?)['"]/m)[1]);
      }
    }

    return {
      appforarr,
      realInputBlocks,
      realInputBlocksALL,
      responseData: rspdids.reduce((acc, r) => {
        acc[r.key] = "";
        return acc;
      }, {}),
      anIds,
      afIds,
    };
  }
};

CalendarSolver = class {
  static async solve(html) {
    let r = html.split('<style id="DateCss">')[1];

    let cssBlockMatch = (r.match(/<style>([\s\S]{100,}?)<\/style>/s) || [""])[1].split("<style>");
    let cssBlock = cssBlockMatch[1] || cssBlockMatch[0];
    let ruleMatch = cssBlock.match(/\.([a-zA-Z0-9]+)\{([\s\S]*?)\}/g) || [""];
    let sitescript_mapping = {};

    if (process.vars.ENABLE_SITEJS == "1") {
      sitescript_mapping = sitescriptsolver.solve(fs.readFileSync(path.resolve(__dirname, "sitejs." + process.vars.COUNTRY + ".js")).toString());
    } else if (process.vars.ENABLE_SITEJS == "2") {
      let sitescript_mapping_string = await dynamicevaluator(html).catch((e) => {
        console.log(e);
        return null;
      });
      if (sitescript_mapping_string === null) throw new Error("can't run dynamicevaluator");
      else if (!sitescript_mapping_string) {
        throw new Error("dynamicevaluator failed");
      } else {
        try {
          console.log(sitescript_mapping_string);
          sitescript_mapping = JSON.parse(sitescript_mapping_string);
        } catch (e) {
          console.log(sitescript_mapping_string);
          throw new Error("dynamicevaluator bad return");
        }
      }
    }

    let sitescript_impact = [];
    let sitescript_impact2 = false;
    if (process.vars.ENABLE_SITEJS == "1") {
      sitescript_impact = [...html.matchAll(new RegExp("(?:" + Object.keys(sitescript_mapping).join("|") + ")([^;]+?);", "g"))].map((m) => {
        return {
          fct: m[0].split("(")[0],
          id: m[0].match(/#(?:div-)?(.+?)\b/)[1],
        };
      });
    } else if (process.vars.ENABLE_SITEJS == "2") {
      sitescript_impact2 = true;
    }

    let rules = ruleMatch
      .map((rule) => {
        let [selector, props] = rule.split("{");
        selector = selector.replace(".", "");
        const propsObj = props
          .replace("}", "")
          .split(";")
          .filter((prop) => prop.trim())
          .map((prop) => prop.trim())
          .reduce((acc, prop) => {
            const [key, value] = prop.split(":").map((prop) => prop.trim());
            acc[key] = value.replace("!important", "").trim();
            return acc;
          }, {});
        return { selector, propsObj };
      })
      .reduce((acc, rule) => {
        acc[rule.selector] = rule.propsObj;
        return acc;
      }, {});

    let elmentmatcher = /<div *class=['"]mb-3 ([^'"]+).+?<label[^>]+for=['"]([^'"]+)['"][^>]*>([^<]+)/gis;

    let elements = [];
    let match;
    while ((match = elmentmatcher.exec(r))) {
      elements.push({
        id: match[2],
        classes: match[1],
        label: match[3],
      });
    }

    let rspdids = [...findFunctionBodyInHTML(r, "OnSubmitSlotSelection").matchAll(/\b(\w+)\s*:\s*\$\(\s*['"]#(\w+)['"]\s*\)/gis)].map((m) => {
      return {
        key: m[1],
        id: m[2],
      };
    });
    elements = elements.filter((e) => rspdids.some((r) => r.id === e.id));

    let inputBlocks = [];
    elements.forEach((block) => {
      let classes = block.classes?.split(/\s+/).filter((prop) => prop.trim());

      let style = classes.reduce((acc, className) => {
        let rule = rules[className];
        if (rule) {
          acc = { ...acc, ...rule };
        }
        return acc;
      }, {});

      let sitescript_impact_onthis = "";
      for (const impact of sitescript_impact) {
        if (impact.id === block.id) {
          if (sitescript_mapping[impact.fct]) {
            sitescript_impact_onthis = sitescript_mapping[impact.fct];
          }
        }
      }

      if (sitescript_impact2) {
        for (const siteaction of sitescript_mapping) {
          for (const className of classes) {
            if (siteaction.className === className) {
              sitescript_impact_onthis = siteaction.action;
            }
          }
        }
      }

      if (style["display"] === "none" && sitescript_impact_onthis !== "show") return;
      if (sitescript_impact_onthis === "hide") return;

      inputBlocks.push({
        id: block.id,
        label: block.label,
      });
    });

    let realInputBlocks = inputBlocks.reduce((acc, block) => {
      let txt = block.label.toLowerCase();
      let trg;

      if (txt.includes("date")) trg = "date";
      else if (txt.includes("slot")) trg = "slot";

      acc[trg] = block;
      return acc;
    }, {});

    return {
      realInputBlocks,
      responseData: rspdids.reduce((acc, r) => {
        acc[r.key] = "";
        return acc;
      }, {}),
    };
  }
};

Captcha = class {
  static handleCaptchaBlockage(html) {
    assert(!html.match(Regexes.captcha_submit_blocked_FOR), `[booker, captcha] Captcha blocked`);
    assert(!html.match(Regexes.captcha_submit_blocked_MAX), `[booker, captcha] Captcha max`);
  }

  static async solve_captcha(login_html, captcha_url) {
    if (!captcha_url) {
      captcha_url = (/iframeOpenUrl *= *["']([^'"]+)/.exec(login_html) ?? [])[1];
    }
    assert(captcha_url, `[booker, captcha] login failed, captcha url not found`);

    const captchaChallengeHtml = await (Captcha.httpManager || process.mainHttpManager).dohttp(captcha_url);
    Captcha.handleCaptchaBlockage(captchaChallengeHtml);

    const { id, captcha, rvt, action } = Captcha.extractCaptchaParams(captchaChallengeHtml);
    assert(id && rvt && action, `[booker, captcha] Captcha params not found id? ${id} rvt? ${rvt} action? ${action}`);

    const solutionString = await CaptchaSolver.solve(captchaChallengeHtml);
    assert(solutionString, `[booker, captcha] Captcha solution not found`);

    return (Captcha.httpManager || process.mainHttpManager).dohttp(action, FormData.captcha(solutionString, id, rvt, captcha), { noXHR: true }).then(async (response) => {
      Captcha.handleCaptchaBlockage(response);

      const json = JSON.parse(response);
      if (json.success) {
        return [decodeHtmlEntities(json.cd || json.captcha), id];
      } else {
        return Captcha.solve_captcha(login_html, captcha_url);
      }
    });
  }

  static async solve_captcha2(captcha_html, moredata = {}) {
    const { id, captcha, rvt, action } = Captcha.extractCaptchaParams(captcha_html);
    assert(id && rvt && action, `[booker, captcha] Captcha params not found id? ${id} rvt? ${rvt} action? ${action}`);

    const solutionString = await CaptchaSolver.solve(captcha_html);
    assert(solutionString, `[booker, captcha] Captcha solution not found`);

    return Captcha.httpManager.dohttp(action, FormData.captcha(solutionString, id, rvt, captcha) + "&" + FormData.encode_object(moredata), {
      noXHR: true,
      full: true,
    });
  }

  static extractCaptchaParams(captchaChallengeHtml) {
    let id = (Regexes.input_Id.exec(captchaChallengeHtml) || [])[1];
    id = id ? decodeHtmlEntities(id) : "";

    let captcha = (Regexes.input_("Captcha").exec(captchaChallengeHtml) || [])[1];
    captcha = captcha ? decodeHtmlEntities(captcha) : "";

    const rvt = (Regexes.input_RVT.exec(captchaChallengeHtml) || [])[1];

    const action = (Regexes.captcha_action_extract.exec(captchaChallengeHtml) || [])[1];

    return { id, captcha, rvt, action };
  }

  static async getCaptchaSol(httpManager, context) {
    let captcha_sol = {};
    while (true && !context?.expired) {
      const resp = await fetch("http://" + process.env.PREFETCH_SERVER_HOST + ":3003/captcha1")
        .then((r) => r.json())
        .catch(() => {
          return {};
        });
      if (resp.captcha) {
        captcha_sol.CaptchaData = resp.captcha;
        captcha_sol.CaptchaId = resp.id || "ac020f99-b291-4cae-b80f-73cd2349918c";
        break;
      } else {
        await new Promise((r) => setTimeout(r, 2100));
      }
    }
    return captcha_sol;
  }
};

CaptchaSolver = class {
  static async solve(html) {
    let challengeData;
    try {
      challengeData = this.getChallengeData(html);
    } catch (e) {
      console.log(e);
      return null;
    }

    try {
      const solutions = await this.recognize(
        challengeData.images.map((img) => decodeHtmlEntities(img.src)),
        challengeData.target,
      );

      const ids = solutions
        .map((e, i) => {
          if (challengeData.target == e) {
            return challengeData.images[i].id;
          }
          return null;
        })
        .filter((e) => e);

      return ids.join(",");
    } catch (e) {
      console.log(e);
    }
  }

  static getChallengeData(html) {
    html = html.split("MAIN CONTENT START")[1] || html;
function getVisibilityOrders(html) {
  let match = html.match(/<\/style>\s*<script>([\s\S]*?)<\/script>/s) || ["", ""];
  let scriptBlock = match[1];
  
  if (!scriptBlock) {
    return {}; // Return empty object if no script found
  }
  
  let setupInstructions = /\$\(function\(\)\{(.+?)\}\);(.+)\s*$/gs.exec(scriptBlock) || ["", "", ""];
  
  if (!setupInstructions[1] || !setupInstructions[2]) {
    return {}; // Return empty object if pattern doesn't match
  }
  
  let setupCalls = setupInstructions[1]
    .split(/\(\);/)
    .filter((call) => call.trim())
    .map((call) => call.trim());

      let funcPattern = /function *([a-zA-Z0-9]+)\(\) *\{\s*try\{\s*([^}]+)\s*\}/g;
      let funcsBlock = setupInstructions[2];
      let funcTmp;
      let funcCalls = {};

      while ((funcTmp = funcPattern.exec(funcsBlock))) {
        let func = funcTmp[2];
        if (!func.startsWith("return")) {
          let name = funcTmp[1];

          let calls = [];
          let callTmp;
          let funcCallPattern = /\$\(['"]#['"] *\+ *document\.getElementById\(['"]([a-zA-Z0-9]+)['"]\)\.id\).(show|hide)\(\);/g;

          while ((callTmp = funcCallPattern.exec(func))) {
            if (!html.match(new RegExp(`id=['"]${callTmp[1]}["']`))) {
              break;
            }

            calls.push({
              id: callTmp[1],
              action: callTmp[2],
            });
          }

          funcCalls[name] = calls;
        }
      }

      let visibilityOrders = {};
      for (let setupCall of setupCalls) {
        let calls = funcCalls[setupCall];
        if (calls) {
          for (let call of calls) {
            if (call.id === "zivug") {
              console.log("zivug ", call.action === "show", "by call", setupCall);
            }
            visibilityOrders[call.id] = call.action === "show";
          }
        }
      }

      return visibilityOrders;
    }

    let cssBlockMatch = html.match(/<style>([\s\S]{100,}?)<\/style>/) || [""];
    let cssBlock = cssBlockMatch[1];
    let ruleMatch = cssBlock.match(/\.([a-zA-Z0-9]+)\{([\s\S]*?)\}/g) || [""];

    let rules = ruleMatch
      .map((rule) => {
        let [selector, props] = rule.split("{");
        selector = selector.replace(".", "");
        const propsObj = props
          .replace("}", "")
          .split(";")
          .filter((prop) => prop.trim())
          .map((prop) => prop.trim())
          .reduce((acc, prop) => {
            const [key, value] = prop.split(":").map((prop) => prop.trim());
            acc[key] = value;
            return acc;
          }, {});
        return { selector, propsObj };
      })
      .reduce((acc, rule) => {
        acc[rule.selector] = rule.propsObj;
        return acc;
      }, {});

    let visibilityOrders = getVisibilityOrders(html);

    let classPattern = /<div[^>]+class=['"](.+?)['"]/;
    let idPattern = /<div[^>]+id=['"](.+?)['"]/;
    let stylePattern = /<div[^>]+style=['"](.+?)['"]/;
    let srcPattern = /<img[^>]+src=['"](.+?)['"]/;

    let imageBlocks = [];

    let imagesMatch = html.match(/<div[^>]+>\s*<img +[^>]+>\s*<\/div>/g) || [];
    imagesMatch.forEach((block) => {
      let imgMatch = block.match(srcPattern) || [""];
      let image = imgMatch[1];
      let idMatch = block.match(idPattern) || [""];
      let id = idMatch[1];

      if (!id) return;

      if (visibilityOrders[id] === false) return;

      let styleMatch = block.match(stylePattern) || [""];
      let inlineStyle = styleMatch[1]
        ?.split(";")
        ?.filter((prop) => prop.trim())
        .reduce((acc, prop) => {
          let [key, value] = prop.split(":").map((prop) => prop.trim());
          acc[key] = value;
          return acc;
        }, {});

      let classesMatch = block.match(classPattern) || [""];
      let classes = classesMatch[1]?.split(/\s+/).filter((prop) => prop.trim());

      let style = classes.reduce((acc, className) => {
        let rule = rules[className];
        if (rule) {
          acc = { ...acc, ...rule };
        }
        return acc;
      }, {});

      for (let key in inlineStyle) {
        style[key] = inlineStyle[key];
      }

      if (style["display"] === "none") return;

      imageBlocks.push({
        image,
        style,
        id,
      });
    });

    let targetImages = {};

    for (let block of imageBlocks) {
      let style = block.style;

      let left = style["left"];
      let top = style["top"];

      let imageGroupId = left + top;
      if (!targetImages[imageGroupId]) {
        targetImages[imageGroupId] = block;
      } else {
        if ((style["z-index"] && targetImages[imageGroupId].style["z-index"] && targetImages[imageGroupId].style["z-index"] < style["z-index"]) || (style["z-index"] && style["z-index"] >= 0 && !targetImages[imageGroupId].style["z-index"])) {
          targetImages[imageGroupId] = block;
        }
      }
    }

    let targetMatch = html.match(/<div[^<]+Please.+number +\d\d\d<\/div>\s/) || [""];
    let targetBlocks = targetMatch[0].split("</div>").filter((block) => block.trim());
    let challengeTarget;

    for (let block of targetBlocks) {
      let idMatch = block.match(idPattern) || [""];
      let id = idMatch[1];
      let styleMatch = block.match(stylePattern);
      let inlineStyle = !styleMatch
        ? {}
        : styleMatch[1]
          .split(";")
          .filter((prop) => prop.trim())
          .reduce((acc, prop) => {
            let [key, value] = prop.split(":").map((prop) => prop.trim());
            acc[key] = value;
            return acc;
          }, {});
      let classMatch = block.match(classPattern) || [""];
      let classes = classMatch[1]
        ?.split(/\s+/)
        .filter((prop) => prop.trim())
        .map((prop) => prop.trim());

      let style = classes.reduce((acc, className) => {
        let rule = rules[className];
        if (rule) {
          acc = { ...acc, ...rule };
        }
        return acc;
      }, {});

      for (let key in inlineStyle) {
        style[key] = inlineStyle[key];
      }

      if (visibilityOrders[id] === false) continue;

      if (style["display"] === "none") continue;

      if (!challengeTarget) {
        challengeTarget = {
          style,
          block,
        };
      } else {
        if ((style["z-index"] && challengeTarget.style["z-index"] && challengeTarget.style["z-index"] < style["z-index"]) || (style["z-index"] && style["z-index"] >= 0 && !challengeTarget.style["z-index"])) {
          challengeTarget = {
            style,
            block,
          };
        }
      }
    }

    let challengeTargetMatch = /(\d\d\d)/.exec(challengeTarget.block) || [""];
    challengeTarget = challengeTargetMatch[1];

    return {
      images: Object.keys(targetImages).map((blockId) => {
        let block = targetImages[blockId];
        return {
          id: block.id,
          src: block.image,
        };
      }),
      target: challengeTarget,
    };
  }

  static getCaptchaAuthorization() {
    const random = Math.floor(Math.random() * 11);

    return btoa(
      (() => random * 3 - 5)() +
      "," +
      "72dd551d869601d192c2a10ae5158d833f707c16c948f8f95f7cb14654f11949"
        .split("")
        .map((c, i) => {
          return c.charCodeAt(0) + random;
        })
        .join(","),
    );
  }

  static async recognize(srcArray, target) {
    let res;
    while (!res) {
      if (process.env.BASSEM_CAPTCHA_KEY) {
        console.log("solving bassem, target", target);
        res = await CaptchaSolver.recoginzeBassemCaptcha(
          srcArray.map((i) => i.split("base64,")[1] || i),
          target,
        ).catch((e) => { });

        if (res && res.length) {
          res = srcArray.map((v, i) => {
            if (res.includes(i)) return target + "";
            else return "";
          });
        }
      }

      if ((!res || !res.length) && process.env.NOCAPTCHA_AI_KEY) {
        let ok = true;
        if (process.env.ALTERNATE_CAPTCHA_MODE) {
          ok = Math.random() > 0.5;
        }
        if (ok) {
          console.log("using nocapai");
          res = await CaptchaSolver.recoginzeNoCaptchaAI(srcArray);
        }
      }

      if (!res || !res.length) {
        console.log("using home captcha");
        await wait(Math.random() * 1000 + 1500);
        res = await CaptchaSolver.recoginzeHomeCaptchaServer(srcArray);
      }

      if (!res) {
        console.log("captcha not solved, retrying after some moments");
        await wait(3500);
      }
    }

    return res;
  }

  static async recoginzeBassemCaptcha(images, target) {
    return new Promise((resolve, reject) => {
      let ac = new AbortController();

      const options = {
        signal: ac.signal,
        // hostname: "impermeable-srv.cheaper.eu.org",
        hostname: process.env.BASSEM_CAPTCHA_HOST || "captchabls.cheaper.eu.org",
        port: parseInt(process.env.BASSEM_CAPTCHA_PORT) || 443,
        path: "/solve",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": process.env.BASSEM_CAPTCHA_KEY,
        },
        agent: process.env.BASSEM_CAPTCHA_PLAIN ? process.captcha_comm_agent : process.captcha_comm_agents,
      };

      const requestData = {
        METHOD: "BLS",
        Images: images,
        Number: target,
      };

      setTimeout(() => {
        ac.abort();
      }, 5000);

      const req = (process.env.BASSEM_CAPTCHA_PLAIN ? http : https).request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("error", (err) => {
          reject(new Error(`Resp Error ${err}`));
        });

        res.on("end", () => {
          try {
            const response = JSON.parse(data);

            if (response.status !== "ok") {
              reject(new Error(`API Error ${data}`));
              return;
            }

            if (!response.selectedIndices) {
              reject("Invalid response format " + data);
              return;
            }

            resolve(response.selectedIndices);
          } catch (err) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      });

      req.on("error", (error) => {
        reject(new Error(`Request failed: ${error.message}`));
      });

      req.write(JSON.stringify(requestData));
      req.end();
    }).catch((e) => {
      console.log("bassem recognition failed", e);
    });
  }

  static async recoginzeNoCaptchaAI(images, module = "morocco") {
    return new Promise((resolve, reject) => {
      const requestData = {
        clientKey: process.env.NOCAPTCHA_AI_KEY,
        task: {
          type: "ImageToTextTask",
          module: module,
          images: images.map((e) => decodeHtmlEntities(e.replace(/^data:image\/(png|jpg|jpeg|gif);base64,/, ""))),
          numeric: true,
          case: false,
          maxLength: 3,
        },
      };

      const options = {
        hostname: "api.nocaptchaai.com",
        path: "/createTask",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        agent: process.captcha_comm_agents,
      };

      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const response = JSON.parse(data);

            if (response.errorId) {
              reject(new Error(`API Error ${response.errorId}: ${response.errorDescription}`));
              return;
            }

            if (!response.solution || !response.solution.text) {
              reject("Invalid response format " + JSON.stringify(response));
              return;
            }

            resolve(response.solution.text);
          } catch (err) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });

        res.on("error", (e) => {
          reject(new Error(`Response failed: ${error.message}`));
        });
      });

      req.on("error", (error) => {
        reject(new Error(`Request failed: ${error.message}`));
      });

      req.write(JSON.stringify(requestData));
      req.end();
    }).catch((e) => {
      console.log("nocaptcha ai recognition failed", e);
    });
  }

  static async recoginzeHomeCaptchaServer(srcArray) {
    let done = false;
    const url = `http://${process.env.CAPTCHA_SERVER_HOST}:${process.env.CAPTCHA_SERVER_PORT}/captcha`;
    let res = await new Promise((resolve, reject) => {
      console.log("contacting", url);
      let req = http
        .request(
          url,
          {
            method: "POST",
            headers: { ["Content-type"]: "application/json", authorization: CaptchaSolver.getCaptchaAuthorization() },
            agent: process.captcha_comm_agent,
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              console.log("captcha main server (solver) response", res.statusCode, data);
              resolve({ status: res.statusCode, data: data });
            });
            res.on("error", (err) => reject(`error while reading from captcha solver: ${err.message}`));
          },
        )
        .end(
          JSON.stringify({
            method: "ocr",
            id: "morocco",
            b: srcArray.map((e) => unescapeHTML(e.replace(/^data:image\/(png|jpg|jpeg|gif);base64,/, ""))),
          }),
        )
        .on("error", (err) => reject(`error while contacting captcha solver: ${err.message}`));

      // setTimeout(() => {
      //   if (!done) {
      //     console.log("captcha server request timeout");
      //     try {
      //       req.destroy();
      //     } catch (e) {}
      //   }
      // }, 30000);
    })
      .then(async (res) => {
        if (res.status !== 200) {
          return `captcha server status_code_error: ${res.status}`;
        } else {
          res = JSON.parse(res.data);
          if (!res.results) return `captcha server results_error: ${JSON.stringify(res)}`;
          return res.results;
        }
      })
      .catch((err) => `error recognizing captcha: ${err.message}`)
      .finally(() => (done = true));

    if (typeof res != "object" || !res.find || !res.find((e) => e)) {
      console.log("Captcha recognition failed: " + res);
      return null;
    } else {
      return res;
    }
  }

  static preloadPreviousCaptchaSolution() {
    if (fs.existsSync(path.join(__dirname, "..", "data", `last_captcha_${process.vars.COUNTRY.toLowerCase()}.json`))) {
      process.vars.LAST_CAPTCHA_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", `last_captcha_${process.vars.COUNTRY.toLowerCase()}.json`), "utf8"));
    }
  }
};

LoginSolver = class {
  static solve(html, bundle_data) {
    function getVisibilityOrders(html) {
      let match = html.match(/<\/style>\s*<script>([\s\S]*?)<\/script>/s) || [""];
      let scriptBlock = match[1];

      let setupInstructions = /\$\(function\(\)\{(.+?)\}\);(.+)\s*$/gs.exec(scriptBlock) || [""];

      let setupCalls = setupInstructions[1]
        .split(/\(\);/)
        .filter((call) => call.trim())
        .map((call) => call.trim());

      let funcPattern = /function *([a-zA-Z0-9]+)\(\) *\{\s*try\{\s*([^}]+)\s*\}/g;
      let funcsBlock = setupInstructions[2];
      let funcTmp;
      let funcCalls = {};

      while ((funcTmp = funcPattern.exec(funcsBlock))) {
        let func = funcTmp[2];
        if (!func.startsWith("return")) {
          let name = funcTmp[1];

          let calls = [];
          let callTmp;
          let funcCallPattern = /\$\(['"]#['"] *\+ *document\.getElementById\(['"]([a-zA-Z0-9]+)['"]\)\.id\).(show|hide)\(\);/g;

          while ((callTmp = funcCallPattern.exec(func))) {
            if (!html.match(new RegExp(`id=['"]${callTmp[1]}["']`))) {
              break;
            }

            calls.push({
              id: callTmp[1],
              action: callTmp[2],
            });
          }

          funcCalls[name] = calls;
        }
      }

      let visibilityOrders = {};
      for (let setupCall of setupCalls) {
        let calls = funcCalls[setupCall];
        if (calls) {
          for (let call of calls) {
            if (call.id === "zivug") {
              console.log("zivug ", call.action === "show", "by call", setupCall);
            }
            visibilityOrders[call.id] = call.action === "show";
          }
        }
      }

      return visibilityOrders;
    }

    let cssBlockMatch = (html.match(/<style>([\s\S]{10,}?)<\/style>/s) || [""])[1].split("<style>");
    let cssBlock = cssBlockMatch[1] || cssBlockMatch[0];
    let ruleMatch = cssBlock.match(/\.([a-zA-Z0-9]+)\{([\s\S]*?)\}/g) || [""];

    let rules = ruleMatch
      .map((rule) => {
        let [selector, props] = rule.split("{");
        selector = selector.replace(".", "");
        const propsObj = props
          .replace("}", "")
          .split(";")
          .filter((prop) => prop.trim())
          .map((prop) => prop.trim())
          .reduce((acc, prop) => {
            const [key, value] = prop.split(":").map((prop) => prop.trim());
            acc[key] = value.replace("!important", "").trim();
            return acc;
          }, {});
        return { selector, propsObj };
      })
      .reduce((acc, rule) => {
        acc[rule.selector] = rule.propsObj;
        return acc;
      }, {});

    let visibilityOrders = getVisibilityOrders(html);

    let classPattern = /<div[^>]+class=['"](.+?)['"]/;
    let idPattern = /<div[^>]+id=['"](.+?)['"]/;
    let stylePattern = /<div[^>]+style=['"](.+?)['"]/;
    let namePattern = /<input[^>]+name=['"](.+?)['"]/;

    const inputBlocks = [];

    const allNames = {};

    let inputsMatch = html.match(/<div[^>]+>\s*<label[^>]+>.+?<\/label>\s*<input[^>]+>/gs) || [];
    inputsMatch.forEach((block) => {
      let idMatch = block.match(idPattern) || [""];
      let id = idMatch[1];

      let nameMatch = block.match(namePattern) || [""];
      let name = nameMatch[1];

      allNames[name] = "";

      if (visibilityOrders[id] === false) return;

      let styleMatch = block.match(stylePattern) || [""];
      let inlineStyle = styleMatch[1]
        ?.split(";")
        ?.filter((prop) => prop.trim())
        .reduce((acc, prop) => {
          let [key, value] = prop.split(":").map((prop) => prop.trim());
          acc[key] = value.replace("!important", "").trim();
          return acc;
        }, {});

      let classesMatch = block.match(classPattern) || [""];
      let classes = classesMatch[1]?.split(/\s+/).filter((prop) => prop.trim());

      let style = classes.reduce((acc, className) => {
        let rule = rules[className];
        if (rule) {
          acc = { ...acc, ...rule };
        }
        return acc;
      }, {});

      for (let key in inlineStyle) {
        style[key] = inlineStyle[key];
      }

      if (style["display"] === "none") return;

      inputBlocks.push({
        style,
        id,
        name,
      });
    });

    allNames[inputBlocks[0].name] = true;

    if (bundle_data) {
      allNames[inputBlocks[0].name] = bundle_data;
      return allNames;
    }

    return [allNames, inputBlocks[0].name];
  }
};

ProxyManager = class {
  constructor(opts = {}) {
    this.proxyManagerServerRoot = opts.proxyManagerServerRoot;
    this.id = process.pid + "-" + Date.now();
    this.proxyAgent = {};

    // let pxFile = opts.proxyFile || ProxyManager.PROXY_FILE || process.vars?.PROXY_FILE;
    // this.proxies = !pxFile
    //   ? []
    //   : fs
    //       .readFileSync(pxFile, "utf8")
    //       .split(/\r?\n/)
    //       .map((e) => e)
    //       .filter(Boolean)
    //       .sort(() => Math.random() - 0.5);
    // this.pxFile = pxFile;

    // if (this.pxFile)
    //   this.proxiesSkipFile = path.join(path.dirname(path.resolve(pxFile)), "skip_" + path.basename(pxFile));
    // this.proxiesSkip = fs.existsSync(this.proxiesSkipFile)
    //   ? fs
    //       .readFileSync(this.proxiesSkipFile, "utf8")
    //       .split(/\r?\n/)
    //       .filter(Boolean)
    //       .reduce((acc, line) => {
    //         const [proxy, timestamp] = line.split("|");
    //         acc[proxy] = timestamp;
    //         return acc;
    //       }, {})
    //   : {};

    this.last_proxy_swap = 0;
    this.n_proxy_swaps = 0;
    // console.info(`loaded ${this.proxies.length} proxies`);
  }

  async chooseProxy(reason, bootstrapProxy) {
    console.log("chooseProxy: reason", reason, "bootstrapProxy", bootstrapProxy);
    this.rawProxy = bootstrapProxy || await this.pickProxy(reason);
    process.vars.PROXY_IN_USE = this.rawProxy;
    console.info(`using proxy ${this.rawProxy}`);

    let proxy = this.constructProxy(this.rawProxy);

    this.proxyAgent.http = new HttpProxyAgent(proxy, {
      keepAlive: !!process.env.PROXY_AGENT_KEEP_ALIVE,
      keepAliveMsecs: process.env.PROXY_AGENT_KEEP_ALIVE_MSECS ? parseInt(process.env.PROXY_AGENT_KEEP_ALIVE_MSECS) : undefined,
      rejectUnauthorized: false,
      maxFreeSockets: parseInt(process.env.PROXY_AGENT_MAX_FREE_SOCKETS),
      maxTotalSockets: parseInt(process.env.PROXY_AGENT_MAX_TOTAL_SOCKETS),
      maxSockets: parseInt(process.env.PROXY_AGENT_MAX_SOCKETS),
    });

    this.proxyAgent.https = new HttpsProxyAgent(proxy, {
      keepAlive: !!process.env.PROXY_AGENT_KEEP_ALIVE,
      keepAliveMsecs: process.env.PROXY_AGENT_KEEP_ALIVE_MSECS ? parseInt(process.env.PROXY_AGENT_KEEP_ALIVE_MSECS) : undefined,
      rejectUnauthorized: false,
      maxFreeSockets: parseInt(process.env.PROXY_AGENT_MAX_FREE_SOCKETS),
      maxTotalSockets: parseInt(process.env.PROXY_AGENT_MAX_TOTAL_SOCKETS),
      maxSockets: parseInt(process.env.PROXY_AGENT_MAX_SOCKETS),
    });

    this.proxyAgent.httpKA = new HttpProxyAgent(proxy, {
      keepAlive: true,
      keepAliveMsecs: process.env.PROXY_AGENT_KEEP_ALIVE_MSECS ? parseInt(process.env.PROXY_AGENT_KEEP_ALIVE_MSECS) : 5000,
      rejectUnauthorized: false,
      maxFreeSockets: parseInt(process.env.PROXY_AGENT_MAX_FREE_SOCKETS),
      maxTotalSockets: parseInt(process.env.PROXY_AGENT_MAX_TOTAL_SOCKETS),
      maxSockets: parseInt(process.env.PROXY_AGENT_MAX_SOCKETS),
    });

    this.proxyAgent.httpsKA = new HttpsProxyAgent(proxy, {
      keepAlive: true,
      keepAliveMsecs: process.env.PROXY_AGENT_KEEP_ALIVE_MSECS ? parseInt(process.env.PROXY_AGENT_KEEP_ALIVE_MSECS) : 5000,
      rejectUnauthorized: false,
      maxFreeSockets: parseInt(process.env.PROXY_AGENT_MAX_FREE_SOCKETS),
      maxTotalSockets: parseInt(process.env.PROXY_AGENT_MAX_TOTAL_SOCKETS),
      maxSockets: parseInt(process.env.PROXY_AGENT_MAX_SOCKETS),
    });
  }

  async swap403Proxy(reason) {
    if (Date.now() - this.last_proxy_swap < 1000 * 10) {
      this.n_proxy_swaps++;
    } else {
      this.n_proxy_swaps = 0;
    }
    this.last_proxy_swap = Date.now();
    // if (this.n_proxy_swaps > 9) {
    //   log_and_exit("too many proxy swaps");
    // }

    await this.chooseProxy(reason);
  }

  getAgent(protocol, type = "KA") {
    if (this.off) return undefined;
    return this.proxyAgent[protocol + type];
  }

  constructProxy(raw) {
    let prts = raw.split(":");
    let proxy = `http://${prts.length > 2 ? `${prts[2]}:${prts[3]}@` : ""}${prts[0]}:${prts[1]}`;

    return proxy;
  }

  async pickProxy(reason) {
    let proxydata;
    let warn = true;
    do {
      if (this.rawProxy) {
        if (this.proxyAgent.https) {
          try {
            this.proxyAgent.https.destroy();
          } catch (e) { }
        }
        if (this.proxyAgent.http) {
          try {
            this.proxyAgent.http.destroy();
          } catch (e) { }
        }
        proxydata = await uiapi.getproxy({
          email: process.env.account_creation_id || process.vars.EMAIL || 1,
          country: process.vars.COUNTRY,
          previousProxy: this.rawProxy,
          reason: reason,
        });
      } else {
        proxydata = await uiapi.getproxy({
          email: process.env.account_creation_id || process.vars.EMAIL || 1,
          country: process.vars.COUNTRY,
          reason: reason,
        });
      }

      if (!proxydata?.proxy) {
        console.warn(`[proxy manager] no proxy found for ${process.vars.COUNTRY}, waiting...`);
        if (warn) {
          info("proxy manager", "no proxy available for " + process.vars.COUNTRY);
          warn = false;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * 5));
      }
    } while (!proxydata?.proxy);
    return proxydata.proxy;
  }

  dumpProxiesSkip() {
    fs.writeFileSync(
      this.proxiesSkipFile,
      Object.entries(this.proxiesSkip)
        .map(([proxy, timestamp]) => `${proxy}|${timestamp}`)
        .join("\n"),
    );
  }
};

HTTPManager = class {
  constructor(proxyManager, baseUrl = "", opts = {}) {
    this.proxyManager = proxyManager || proxyManager === true ? new ProxyManager() : undefined;

    this.cookieJar = {};
    process.vars.COOKIES_JAR = {};

    // if (process.vars.COUNTRY === "morocco" && process.env.awswaftoken) {
    //   this.cookieJar['aws-waf-token'] = process.env.awswaftoken;
    //   process.vars.COOKIES_JAR['aws-waf-token'] = process.env.awswaftoken;
    // }

    this.CONDITIONAL_PROXY_SWAP = opts.CONDITIONAL_PROXY_SWAP || process.vars.HTTPManager_CONDITIONAL_PROXY_SWAP || (() => false);
    this.RETRY_ON_HTTP_CODE = opts.RETRY_ON_HTTP_CODE || process.vars.HTTPManager_RETRY_ON_HTTP_CODE || [];
    this.OK_HTTP_ROUTINES = opts.OK_HTTP_ROUTINES || process.vars.HTTPManager_OK_HTTP_ROUTINES || [];
    this.ONBEFORE_REQUEST = opts.ONBEFORE_REQUEST || process.vars.HTTPManager_ONBEFORE_REQUEST || [];
    this.ONAFTER_REQUEST = opts.ONAFTER_REQUEST || process.vars.HTTPManager_ONAFTER_REQUEST || [];
    this.SWAP_SLOW_PROXY_ON_FIRST_REQUEST = opts.SWAP_SLOW_PROXY_ON_FIRST_REQUEST !== undefined ? opts.SWAP_SLOW_PROXY_ON_FIRST_REQUEST : process.vars.HTTPManager_SWAP_SLOW_PROXY_ON_FIRST_REQUEST || false;
    this.RETRY_ON_REQUEST_ERROR = opts.RETRY_ON_REQUEST_ERROR !== undefined ? opts.RETRY_ON_REQUEST_ERROR : process.vars.HTTPManager_RETRY_ON_REQUEST_ERROR || false;
    this.SIMULATE_BROWSER = opts.SIMULATE_BROWSER !== undefined ? opts.SIMULATE_BROWSER : process.vars.HTTPManager_SIMULATE_BROWSER || false;

    this.FIRST_REQUEST_DONE = false;
    this.REQUEST_TIMEOUT = opts.REQUEST_TIMEOUT || process.vars.HTTPManager_REQUEST_TIMEOUT;
    this.DYNAMIC_REQUEST_TIMEOUT = opts.DYNAMIC_REQUEST_TIMEOUT || process.vars.HTTPManager_DYNAMIC_REQUEST_TIMEOUT;
    this.DYNAMIC_REQUEST_AGENT = opts.DYNAMIC_REQUEST_AGENT || process.vars.HTTPManager_DYNAMIC_REQUEST_AGENT;

    if (this.SIMULATE_BROWSER) {
      this.SIMULATE_BROWSER_HEADERS = {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7,ar;q=0.6",
        "cache-control": "max-age=0",
        priority: "u=0, i",
        "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
      };
    }

    this.request_errors_counter = {};
    this.response_codes_counter = {};
    this.consecutive_errors_counter = {};

    const ua = JSON.parse(fs.readFileSync(path.resolve(__dirname, "ua.json")).toString());

    // this.userAgent = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";
    //Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36
    this.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    process.vars.userAgent = this.userAgent
    // this.userAgent =  opts.userAgent || process.vars.HTTPManager_USER_AGENT || ua[Math.floor(Math.random() * ua.length)];

    this.clientOptions = {
      headers: {
        "User-Agent": this.userAgent,
      },
    };
    this.baseUrl = baseUrl;

    this.identifier = opts.IDENTIFIER || process.vars.HTTPManager_IDENTIFIER || "http manager";

    this.disableLog = opts.DISABLE_LOG || process.vars.HTTPManager_DISABLE_LOG;
  }

  resolveURL(url) {
    if (url.startsWith("http")) return url;
    return this.baseUrl + (url.startsWith("/") ? url.substring(1) : url);
  }

  async head_(url, options = {}, context) {
    return this.head(url, options, context);
  }

  async head(url, options = {}, context) {
    return this.makeRequest(url, options, "head", undefined).then(async (response) => {
      if (context?.expired) return {};
      return this.resolutionCallback(response, url, options, "head", undefined);
    });
  }

  async get_(url, options = {}, context) {
    return this.get(url, options, context);
  }

  async get(url, options = {}, context) {
    return this.makeRequest(url, options, "get", undefined)
      .then(async (response) => {
        if (context?.expired) return {};
        return this.resolutionCallback(response, url, options, "get", undefined);
      })
      .catch((e) => {
        if (context?.expired) return {};
        return this.rejectionCallback(e, url, options, "get", undefined);
      });
  }

  async post_(url, data, options = {}, context) {
    return this.post(url, options, data, context);
  }

  async post(url, options = {}, data, context) {
    return this.makeRequest(url, options, "post", data)
      .then(async (response) => {
        if (context?.expired) return {};
        return this.resolutionCallback(response, url, options, "post", data);
      })
      .catch((e) => {
        if (context?.expired) return {};
        return this.rejectionCallback(e, url, options, "post", data);
      });
  }

  async resolutionCallback(response, url, options, method, data) {
    if (!this.disableLog) console.info(`[${this.identifier}] success,`, response.statusCode, url);

    if (response.statusCode === 200 && (!response.body || response.body.length === 0) && process.env.RETRY_EMPTY_BODY) {
      this.home_error_redirect_counter = 0
      await new Promise((resolve) => setTimeout(resolve, 500));
      return this[method](url, options, data);
    }

    if (response.statusCode === 302 && process.env.RETRY_ERROR_REDIRECT && response.headers?.location?.toLowerCase().includes('/home/error')) {
      if (this.home_error_redirect_counter === undefined) this.home_error_redirect_counter = 0
      this.home_error_redirect_counter++

      let max_home_error_redirect_count = parseInt(process.env.MAX_HOME_ERROR_REDIRECT_COUNT || 15)

      if (this.home_error_redirect_counter < max_home_error_redirect_count) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return this[method](url, options, data);
      }
    }
    this.home_error_redirect_counter = 0

    for (const callback of this.ONAFTER_REQUEST) {
      await callback(response, url, options, method, data);
    }

    if (!this.response_codes_counter[response.statusCode]) {
      this.response_codes_counter[response.statusCode] = {
        count: 0,
        count_10s: 0,
        count_30s: 0,
        lastTime10s: Date.now(),
        lastTime30s: Date.now(),
      };
    }
    if (Date.now() - this.response_codes_counter[response.statusCode].lastTime10s > 10 * 1000) {
      this.response_codes_counter[response.statusCode].count_10s = 0;
      this.response_codes_counter[response.statusCode].lastTime10s = Date.now();
    }
    if (Date.now() - this.response_codes_counter[response.statusCode].lastTime30s > 30 * 1000) {
      this.response_codes_counter[response.statusCode].count_30s = 0;
      this.response_codes_counter[response.statusCode].lastTime30s = Date.now();
    }

    this.response_codes_counter[response.statusCode].count++;
    this.response_codes_counter[response.statusCode].count_10s++;
    this.response_codes_counter[response.statusCode].count_30s++;

    if (this.consecutive_errors_counter.code !== response.statusCode) {
      this.consecutive_errors_counter.code = response.statusCode;
      this.consecutive_errors_counter.count = 0;
    }
    this.consecutive_errors_counter.count++;

    if (await this.CONDITIONAL_PROXY_SWAP(response, this)) {
      if (!this.disableLog) console.info(`[${this.identifier}] ${response.statusCode}, conditional proxy swap`);
      await this.proxyManager.swap403Proxy("HTTP_CODE:" + response.status);
      this.request_errors_counter = {};
      this.response_codes_counter = {};
      return this[method](url, options, data);
    }

    for (const retry_on_http_code of this.RETRY_ON_HTTP_CODE) {
      if ((retry_on_http_code.length && retry_on_http_code[0] <= response.statusCode && response.statusCode <= retry_on_http_code[1]) || retry_on_http_code === response.statusCode) {
        if (!this.disableLog) console.info(`[${this.identifier}] ${response.statusCode}, retrying after ${retry_on_http_code[2] || 0} ms`);
        await new Promise((resolve) => setTimeout(resolve, retry_on_http_code[2] || 0));
        return this[method](url, options, data);
      }
    }

    for (const ok_http_routine of this.OK_HTTP_ROUTINES) {
      await ok_http_routine(response, this);
    }

    this.FIRST_REQUEST_DONE = true;

    return response;
  }

  async rejectionCallback(e, url, options, method, data) {
    console.error(`request error`, e.message, e.code, e.error);

    for (const callback of this.ONAFTER_REQUEST) {
      await callback(null, url, options, method, data, e);
    }

    if (!this.request_errors_counter[e.code]) {
      this.request_errors_counter[e.code] = {
        count: 0,
        count_10s: 0,
        count_30s: 0,
        lastTime10s: Date.now(),
        lastTime30s: Date.now(),
      };
    }

    if (Date.now() - this.request_errors_counter[e.code].lastTime10s > 10 * 1000) {
      this.request_errors_counter[e.code].count_10s = 0;
      this.request_errors_counter[e.code].lastTime10s = Date.now();
    }
    if (Date.now() - this.request_errors_counter[e.code].lastTime30s > 30 * 1000) {
      this.request_errors_counter[e.code].count_30s = 0;
      this.request_errors_counter[e.code].lastTime30s = Date.now();
    }

    this.request_errors_counter[e.code].count++;
    this.request_errors_counter[e.code].count_10s++;
    this.request_errors_counter[e.code].count_30s++;

    if (await this.CONDITIONAL_PROXY_SWAP(undefined, this, e)) {
      if (!this.disableLog) console.warn(`[${this.identifier}] ${e.code}, ${this.request_errors_counter[e.code].count_30s} times in 30s, swapping proxy`);
      await this.proxyManager.swap403Proxy(e.code);
      this.request_errors_counter = {};
      this.response_codes_counter = {};
    } else if (e.message === "Request timed out" && this.SWAP_SLOW_PROXY_ON_FIRST_REQUEST && !this.FIRST_REQUEST_DONE) {
      if (!this.disableLog) console.warn(`[${this.identifier}] swapping proxy on first request`);
      await this.proxyManager.swap403Proxy("ON_FIRST_REQUEST");
      this.request_errors_counter = {};
      this.response_codes_counter = {};
    } else if (this.RETRY_ON_REQUEST_ERROR) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      throw e;
    }

    return this[method](url, options, data);
  }

  getProtocol(url) {
    if (url.startsWith("https:")) {
      return "https";
    }
    return "http";
  }

  async makeRequest(url, options = {}, method, data) {
    // if (process.vars.updatewaftoken) {
    //   this.cookieJar['aws-waf-token'] = process.env.awswaftoken;
    //   process.vars.COOKIES_JAR['aws-waf-token'] = process.env.awswaftoken;
    // }

    for (const callback of this.ONBEFORE_REQUEST) {
      await callback(url, options, method, data);
    }

    let targetURL;
    if (!url.startsWith("http")) targetURL = this.baseUrl + (url.startsWith("/") ? url.substring(1) : url);
    else targetURL = url;

    const protocol = this.getProtocol(targetURL);
    let httpClient = protocol === "http" ? http : https;

    // if (process.env.BYPASS429) {
    if (false && process.vars.COUNTRY === "algeria") {
      let targetURLLower = targetURL.toLowerCase();
      // if(process.vars.COUNTRY === "algeria"){
      if (targetURLLower.includes('bls') && !targetURLLower.includes('login') && !targetURLLower.includes('manageapplicant') && (!targetURLLower.includes('myappointments') || process.env.BYPASS_MYAPPS) && (targetURLLower.includes('data') || process.env.BYPASS429ALL)) {
        let parts = targetURL.split('/');
        if (parts[5]) {
          if (parts[5].includes('?')) {
            let params = parts[5].split('?')
            parts[5] = params[0] + '/.js?' + params[1];
          } else {
            if (parts[5].endsWith('/')) {
              parts[5] = parts[5] + '.js';
            } else {
              parts[5] = parts[5] + '/.js';
            }
          }

          targetURL = parts.join('/');
          console.log('new target url', targetURL);
        }
      }
    }

    let merge = (a, b) => {
      const undefinedGuard = (o, oo) => (o ? o : Array.isArray(oo) ? [] : {});
      const c = undefinedGuard(undefined, undefined);

      for (const k of [...Object.keys(a), ...Object.keys(b)]) {
        if (typeof a[k] === "object") c[k] = merge(undefinedGuard(a[k], b[k]), undefinedGuard(b[k], a[k]));
        else c[k] = b[k] === undefined ? a[k] : b[k];
      }

      return c;
    };

    let agentType = "KA";
    if (this.DYNAMIC_REQUEST_AGENT && !process.env.USE_ONE_PROXY_AGENT) {
      for (const rule of this.DYNAMIC_REQUEST_AGENT) {
        if (url.toLowerCase().includes(rule.url)) {
          agentType = rule.type;
          break;
        }
      }
    } else if (process.env.USE_ONE_PROXY_AGENT) {
      agentType = "";
    }

    const requestOptions = {
      rejectUnauthorized: false,
      preambleCRLF: true,
      postambleCRLF: true,
      agent: /^https?:\/\/(?:localhost|0.0.0.0|127.0.0.1).*/.test(targetURL) ? undefined : this.proxyManager?.getAgent(protocol, agentType),
      method,
      setHost: true,
      keepAlive: true,
      ...merge(this.clientOptions, options),
    };

    if (!requestOptions.headers) requestOptions.headers = {};
    requestOptions.headers["connection"] = "keep-alive";
    requestOptions.headers["cookie"] = Object.keys(this.cookieJar)
      .map((cookieName) => `${cookieName}=${this.cookieJar[cookieName]}`)
      .join("; ");
    if (!requestOptions.headers["cookie"]) delete requestOptions.headers["cookie"];

    if (!requestOptions.headers["origin"] && !this.DONT_ORIGIN) {
      if (!this.ORIGIN) this.ORIGIN = new URL(targetURL).origin;
      requestOptions.headers["origin"] = this.ORIGIN;
    }

    if (this.SIMULATE_BROWSER) {
      requestOptions.headers = {
        ...this.SIMULATE_BROWSER_HEADERS,
        ...requestOptions.headers,
      };
    }

    // requestOptions.headers['origin'] = this.baseUrl;
    process.vars.LAST_HTTP_REQUEST = {
      targetURL,
      ...merge(this.clientOptions, options),
      data: url?.toLowerCase().includes("blsappointment/submitlivenessdetection") ? "too long: " + data.length : data,
    };

    if (data && !requestOptions.headers["content-type"]) {
      if (typeof data === "string") {
        requestOptions.headers["content-length"] = Buffer.byteLength(data);
        requestOptions.headers["content-type"] = "application/x-www-form-urlencoded";
      } else if (data instanceof Buffer) {
        requestOptions.headers["content-length"] = data.length;
        requestOptions.headers["content-type"] = "multipart/form-data";
      } else if (typeof data === "object") {
        requestOptions.headers["content-type"] = "application/json";
        data = JSON.stringify(data);
        requestOptions.headers["content-length"] = Buffer.byteLength(data);
      }
    }

    // let hostname = new URL(targetURL).hostname;
    // const addresses =
    //   [hostname] ||
    //   (await new Promise((resolve, reject) => {
    //     require("dns").lookup(hostname, { all: true }, (err, addresses) => {
    //       if (err) {
    //         console.error(err);
    //         resolve([hostname]);
    //       } else resolve(addresses);
    //     });
    //   }));
    // let randomAddress = addresses[Math.floor(Math.random() * addresses.length)];
    // targetURL = targetURL.replace(hostname, randomAddress.address);
    // console.log(`[${this.identifier}] targetURL, targetURL);

    // requestOptions.headers["User-Agent"] = process.vars.GR_UA || requestOptions.headers["User-Agent"];

    let timeout;
    return new Promise((resolve, reject) => {
      let req;
      let datareq = false,
        ended1 = false,
        ended2 = false;

      let request_timeout = undefined;

      if (this.DYNAMIC_REQUEST_TIMEOUT) {
        for (const rule of this.DYNAMIC_REQUEST_TIMEOUT) {
          if (url.toLowerCase().includes(rule.url) && (!rule.method || rule.method === method.toLowerCase())) {
            request_timeout = rule.timeout;
            break;
          }
        }
      }

      if (request_timeout === undefined && this.REQUEST_TIMEOUT) request_timeout = this.REQUEST_TIMEOUT;

      if (request_timeout !== undefined)
        timeout = setTimeout(() => {
          let error = new Error("Request timed out");
          error.code = "XYZ_NETWORK_TIMEOUT";
          if (!this.disableLog) console.log(`[${this.identifier}] request timed out. isdatareq:` + datareq + " ended1:" + ended1 + " ended2:" + ended2);
          reject(error);
        }, request_timeout);

      let start_time = Date.now();
      req = httpClient.request(targetURL, requestOptions, (res) => {
        this.parseCookies(res.headers);

        let bodyBuffer = [];
        res.on("data", (chunk) => {
          bodyBuffer.push(chunk);
        });
        res.on("end", () => {
          resolve(
            (process.vars.LAST_HTTP_ANSWER = {
              statusCode: res.statusCode,
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(bodyBuffer).toString(),
              time: Date.now() - start_time,
            }),
          );
        });
      });

      req.on("error", reject);
      if (data) {
        datareq = true;
        req.write(data);
      }
      ended1 = true;
      req.end();
      ended2 = true;
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  parseCookies(headers) {
    if (!headers["set-cookie"]) return;
    headers["set-cookie"].forEach((cookie) => {
      let [name, value] = cookie.split(";")[0].split("=");
      if (value || (!value && !process.env.PERSIST_COOKIES)) {
        this.cookieJar[name] = value;
        process.vars.COOKIES_JAR[name] = value;
      }
    });
  }

  async dohttp(path, data, opts) {
    const options = {};
    const { noXHR, full, headers } = opts || {};

    options.headers = headers || {};

    if (data !== undefined && typeof data === "string") {
      options.headers["content-length"] = Buffer.byteLength(data);
      options.headers["content-type"] = "application/x-www-form-urlencoded";
      if (!noXHR) {
        options.headers["x-requested-with"] = "XMLHttpRequest";
      }
    } else if (data && data instanceof Buffer) {
      options.headers["content-length"] = data.length;
      if (!opts.headers["content-type"]) {
        options.headers["content-type"] = "multipart/form-data";
      }
      if (!noXHR) {
        options.headers["x-requested-with"] = "XMLHttpRequest";
      }
    }

    const executeRequest = async () =>
      this[data !== undefined ? "post" : "get"](path, options, data)
        .then(async (response) => {
          return full ? response : response.body;
        })
        .catch((e) => {
          console.error(`request error`, e.message, e.code, e.error);
          if (this.RETRY_ON_REQUEST_ERROR) {
            return this.dohttp(path, data, opts);
          }
          throw e;
        });

    return executeRequest();
  }

  static get_multipart_data(object, files) {
    const boundary = `--InsiBrowser${Math.random().toString(36).substring(2)}yzawsbs`;

    let data = "";
    for (const i in object) {
      data += "--" + boundary + "\r\n";
      data += 'Content-Disposition: form-data; name="' + i + '"; \r\n\r\n' + object[i] + "\r\n";
    }
    data = Buffer.from(data, "utf8");
    for (const file of files) {
      const filepath = file.filepath;
      const filename = file.filename || (filepath ? path.basename(filepath) : "file.png");
      const fieldName = file.fieldName || "file";
      data = Buffer.concat([
        data,
        Buffer.from(`--${boundary}\r\n`, "utf8"),
        Buffer.from(`Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`, "utf8"),
        Buffer.from(`Content-Type: image/${filename.split(".").pop().toLowerCase()}\r\n\r\n`, "utf8"),
        file.fileBuffer || fs.readFileSync(filepath),
        Buffer.from(`\r\n`, "utf8"),
      ]);
    }
    if (data.length) {
      data = Buffer.concat([data, Buffer.from(`--${boundary}--\r\n`, "utf8")]);
    }

    return [data, boundary];
  }
};

function decodeHtmlEntities(str) {
  return unescapeHTML(str);
  return str.replace(/&(#x?[\w\d]+);/g, (match, code) => {
    if (code.startsWith("#x")) {
      // Hexadecimal entity
      return String.fromCharCode(parseInt(code.substring(2), 16));
    } else if (code.startsWith("#")) {
      // Decimal entity
      return String.fromCharCode(parseInt(code.substring(1), 10));
    } else {
      // Named entity
      const entities = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        // Add more named entities as needed
      };
      return entities[code] || match;
    }
  });
}

function findFunctionBodyInHTML(html, functionName) {
  const partOK = html.split(new RegExp("function\\s+" + functionName))[1] || html.split(new RegExp(functionName + "\\s*=\\s*(?:async\\s*)?(?:\\(|function)"))[1];
  let openFound = false;
  let closeFound = false;
  let bypassOne = 0;
  let i = 0;
  while (!closeFound) {
    if (partOK[i] === "{") {
      if (openFound) {
        bypassOne++;
      } else {
        openFound = true;
      }
    } else if (partOK[i] === "}") {
      if (bypassOne === 0) {
        closeFound = true;
      } else {
        bypassOne--;
      }
    }
    i++;
  }

  return partOK.substring(0, i);
}

function unescapeHTML(str) {
  if (!str) return str;

  var htmlEntities = {
    nbsp: " ",
    cent: "¢",
    pound: "£",
    yen: "¥",
    euro: "€",
    copy: "©",
    reg: "®",
    lt: "<",
    gt: ">",
    quot: '"',
    amp: "&",
    apos: "'",
  };

  return str.replace(/\&([^;]+);/g, function (entity, entityCode) {
    var match;

    if (entityCode in htmlEntities) {
      return htmlEntities[entityCode];
    } else if ((match = entityCode.match(/^#x([\da-fA-F]+)$/))) {
      return String.fromCharCode(parseInt(match[1], 16));
    } else if ((match = entityCode.match(/^#(\d+)$/))) {
      return String.fromCharCode(~~match[1]);
    } else {
      return entity;
    }
  });
}

class VTWork {
  static generateRspd({ apci, loc, vType, vSubType, miss, ani, m, a }) {
    let min = 1 * 1000,
      max = 7 * 1000,
      diffchoice = () => Math.floor(Math.random() * (max - min + 1)) + min,
      date = new Date(Date.now());
    let date2 = new Date(date.getTime() + diffchoice());

    let rspd = [
      {
        Id: "AppointmentCategoryId" + apci,
        Start: date,
        End: date2,
        Total: date2 - date,
        Selected: true,
      },
    ];

    date = date2;
    date2 = new Date(date.getTime() + diffchoice());
    rspd.push({
      Id: "Location" + loc,
      Start: date,
      End: date2,
      Total: date2 - date,
      Selected: true,
    });

    date = date2;
    date2 = new Date(date.getTime() + diffchoice());
    rspd.push({
      Id: "VisaType" + vType,
      Start: date,
      End: date2,
      Total: date2 - date,
      Selected: true,
    });

    date = date2;
    date2 = new Date(date.getTime() + diffchoice());
    rspd.push({
      Id: "VisaSubType" + vSubType,
      Start: date,
      End: date2,
      Total: date2 - date,
      Selected: true,
    });

    if (m) {
      date = date2;
      date2 = new Date(date.getTime() + diffchoice());
      rspd.push({
        Id: "Mission" + miss,
        Start: date,
        End: date2,
        Total: date2 - date,
        Selected: true,
      });
    }

    if (a > 1) {
      date = date2;
      date2 = new Date(date.getTime() + diffchoice());
      rspd = [
        ...rspd,
        {
          Id: "ApplicantsNo" + ani,
          Start: date,
          End: date2,
          Total: date2 - date,
          Selected: true,
        },
      ];
    }

    return rspd;
  }

  static get_visa_type_params() {
    const { locationData, visaIdData, visasubIdData, AppointmentCategoryIdData, missionData } = process.data.VISA_META;
    const selectedApp = process.vars.TARGET_VISA;

    let l = locationData.filter((e) => e.Name.toLowerCase() === selectedApp.visa_center_location.toLowerCase())[0]?.Id;
    if (!l) l = locationData.filter((e) => e.Name.toLowerCase().includes(selectedApp.visa_center_location.toLowerCase()))[0].Id;

    let vt = visaIdData.filter((e) => e.Name.toLowerCase() === selectedApp.visa_type.toLowerCase() && (!e.LocationId || new RegExp(`\\b${l}\\b`).test(e.LocationId.toString())))[0]?.Id;
    if (!vt) vt = visaIdData.filter((e) => e.Name.toLowerCase().includes(selectedApp.visa_type.toLowerCase()) && (!e.LocationId || new RegExp(`\\b${l}\\b`).test(e.LocationId.toString())))[0]?.Id;
    if (!vt) vt = visaIdData.filter((e) => e.Name.toLowerCase().includes(selectedApp.visa_type.toLowerCase()))[0]?.Id;

    let acid = AppointmentCategoryIdData.filter((e) => e.Name.toLowerCase() === selectedApp.visa_appointement_category.toLowerCase() && (!e.LocationId || new RegExp(`\\b${l}\\b`).test(e.LocationId.toString())))[0]?.Id;
    if (!acid) acid = AppointmentCategoryIdData.filter((e) => e.Name.toLowerCase().includes(selectedApp.visa_appointement_category.toLowerCase()) && (!e.LocationId || new RegExp(`\\b${l}\\b`).test(e.LocationId.toString())))[0]?.Id;
    if (!acid) acid = AppointmentCategoryIdData.filter((e) => e.Name.toLowerCase().includes(selectedApp.visa_appointement_category.toLowerCase()))[0]?.Id;

    let vst = visasubIdData.filter((e) => e.Name.toLowerCase() === selectedApp.visa_subtype.toLowerCase() && (!e.Value || new RegExp(`\\b${vt}\\b`).test(e.Value.toString())))[0]?.Id;
    if (!vst) vst = visasubIdData.filter((e) => e.Name.toLowerCase().includes(selectedApp.visa_subtype.toLowerCase()) && (!e.Value || new RegExp(`\\b${vt}\\b`).test(e.Value.toString())))[0]?.Id;
    if (!vst) vst = visasubIdData.filter((e) => e.Name.toLowerCase().includes(selectedApp.visa_subtype.toLowerCase()))[0]?.Id;

    let m = missionData.filter((e) => e.Name.toLowerCase() === selectedApp.visa_center_location.toLowerCase())[0]?.Id || "";
    if (!m) m = missionData.filter((e) => e.Name.toLowerCase().includes(selectedApp.visa_center_location.toLowerCase()))[0]?.Id || "";

    let af = selectedApp.visa_appointement_for;
    let an = af === "Family" ? parseInt(selectedApp.visa_applicants_no) : 1;

    if (process.vars.ROTATE_CATEGORY) {
      if (process.vars.ROTATE_CATEGORY_SAVED_VALUE) {
        acid = process.vars.ROTATE_CATEGORY_SAVED_VALUE;

        const filteredAPCID = AppointmentCategoryIdData.filter((e) => !e.LocationId || new RegExp(`\\b${l}\\b`).test(e.LocationId.toString()));
        let i = filteredAPCID.findIndex((e) => e.Id === acid);
        if (i >= 0) acid = filteredAPCID[(i + 1) % filteredAPCID.length].Id;
        else acid = filteredAPCID[0]?.Id || acid;
      }
      process.vars.ROTATE_CATEGORY_SAVED_VALUE = acid;
    }
    console.info(`[utils, get_visa_type_params] using category: ${acid}/${AppointmentCategoryIdData.find((e) => e.Id === acid)?.Name}`);
    console.info(`[utils, get_visa_type_params] using visa_type/visa_subtype/location: ${selectedApp.visa_type}/${selectedApp.visa_subtype}/${selectedApp.visa_center_location}`, 222222222);

    let visastObj = visasubIdData.filter((e) => e.Name.toLowerCase().includes(selectedApp.visa_subtype.toLowerCase()))[0];

    if (visastObj?.Code !== "WEB_EMBASSY") {
      m = "";
    }

    return {
      location: l,
      visatype: vt,
      visasubtype: vst,
      category: acid,
      mission: m,
      app_for: af,
      applicants_no: an,
    };
  }

  // static form_data(html) {
  //   let visaTypeParams = VTWork.get_visa_type_params();

  //   let formInfo = "";
  //   let scriptDataEncoded;
  //   const formInfoBase = ["ApplicantsNo", "AppointmentCategoryId", "AppointmentFor", "Location", "Mission", "VisaSubType", "VisaType"];
  //   let formInfoBaseScriptDataIndexes = formInfoBase.map((e) => null);
  //   let formInfoBaseCustomFillers = formInfoBase.map((e) => null);
  //   let formInfoBaseValues = [
  //     (visaTypeParams.applicants_no == 1 ? "" : visaTypeParams.applicants_no).toString(),
  //     visaTypeParams.category,
  //     visaTypeParams.app_for,
  //     visaTypeParams.location,
  //     visaTypeParams.mission,
  //     visaTypeParams.visasubtype,
  //     visaTypeParams.visatype,
  //   ];

  //   if (process.vars.COUNTRY === "egypt") {
  //     scriptDataEncoded = encodeURIComponent(
  //       "jo+WrPiNo78ZDGuNpLOXpEo5tcRburItrGNsaJgbsr2egGOWEvOhGb42RWKjpqnuYiDlM8j+EcDFQAvf+zFLdD94AYKWm1rBn26yN63PYcKc6jylvFmPvKrAJk8HFCekd1JPk6jgODiWFiwPO2L9Cjk7kLxLSHDljG3hJg2lauUTxKWN8W1lXWqqG1Rxq3FUAI/xYMflWTsFuxit4XDmqxb0XDA55ekWWeIH8nqN2tNXA0g1uu1O8IPfziUSVrzlhfeMFnwY+elQGgNmsHVyMXFvmCM6Mg06C8J7NdZVvGvBOFZR+uxcG70tlEgxeWebPxoNEvbG/ONHRYTEPQcwCYnj8eX8l8wdkB+UZNt8ff0="
  //     );

  //     formInfoBaseScriptDataIndexes = [5, 3, 3, 5, 5, 5, 5];
  //     formInfoBaseCustomFillers[formInfoBase.indexOf("AppointmentFor")] = (e) => "Individual";
  //   } else if (process.vars.COUNTRY === "russia") {
  //     scriptDataEncoded = encodeURIComponent(
  //       "jo+WrPiNo78ZDGuNpLOXpLkB1dnebCQd/JKF6XhqfJaSVQcHjivr7gtuICjCpWHW5+AUHH8t0mEG7ZswEHZ0NinUbplQUpHsI5vOsIPdNxNq5wYMfe/ZN4/diVGAsHtTyy8itmEWHlhoXqbH7rdrt4aTRusNTHKWv0Yo4aFFGjf2DNCIGNmj7SdZW8NNorc3o852uBKYqbhR3zcyXYKl2YtVPBlYuWBn+1h6t5eibXblr1aFiY/QTrhR8uyjx7Nh5q5hGEBJqGzIQeFKTAEgN+1IezDDKmXsrQdzYhWPQMvKklE5+KmBLlfH0qvivz88zpyYJ6JODMEv4uid/GGh/In7Kdw1G07UETwBGSyyFHXjUqVux9kn6VUBmHMEpsOH"
  //     );

  //     formInfo = `JurisdictionId4=e856324e-3e08-43f1-b0f8-b5dd4fce406c&JurisdictionId1=&JurisdictionId2=&JurisdictionId3=&JurisdictionId5=&loc1=&loc2=&loc3=&loc4=&loc5=&`;

  //     formInfoBaseScriptDataIndexes = [4, 4, 4, 4, 4, 4, 4];
  //   } else if (process.vars.COUNTRY === "uk") {
  //     scriptDataEncoded = encodeURIComponent(
  //       "jo+WrPiNo78ZDGuNpLOXpEo5tcRburItrGNsaJgbsr2egGOWEvOhGb42RWKjpqnuYiDlM8j+EcDFQAvf+zFLdD94AYKWm1rBn26yN63PYcKc6jylvFmPvKrAJk8HFCekd1JPk6jgODiWFiwPO2L9Cjk7kLxLSHDljG3hJg2lauUTxKWN8W1lXWqqG1Rxq3FUAI/xYMflWTsFuxit4XDmq30ONZIvnW4SGX4Vc+YRlMcdFezXIKrb0Cj5GJHAi9oNb7fg+zVso/OHX2eRF7U06ooXQDXqtNZEGCYVrqXx6vY+4k1oHYbppwwz2fViB1w+mIWUmqLwk4+BjA3ofhpTqr5cGin0vrSyRxkKC1YrH5Y7DKUXGPFqjJBoXYq7IbQH"
  //     );

  //     formInfo = `JurisdictionId4=&JurisdictionId1=&JurisdictionId2=&JurisdictionId3=&JurisdictionId5=${
  //       process.data.VISA_META.jurisdictionData.find((e) => e.Value.includes(visaTypeParams.location))?.Id
  //     }&loc1=&loc2=&loc3=&loc4=&loc5=&`;

  //     formInfoBaseScriptDataIndexes = [1, 3, -1, 5, 5, 5, 5];
  //   } else if (process.vars.COUNTRY === "mauritania") {
  //     scriptDataEncoded = encodeURIComponent(
  //       "jo+WrPiNo78ZDGuNpLOXpEo5tcRburItrGNsaJgbsr2egGOWEvOhGb42RWKjpqnuYiDlM8j+EcDFQAvf+zFLdD94AYKWm1rBn26yN63PYcKc6jylvFmPvKrAJk8HFCekd1JPk6jgODiWFiwPO2L9Cjk7kLxLSHDljG3hJg2lauUTxKWN8W1lXWqqG1Rxq3FUAI/xYMflWTsFuxit4XDmq30ONZIvnW4SGX4Vc+YRlMcdFezXIKrb0Cj5GJHAi9oNb7fg+zVso/OHX2eRF7U06ooXQDXqtNZEGCYVrqXx6vY+4k1oHYbppwwz2fViB1w+mIWUmqLwk4+BjA3ofhpTqr5cGin0vrSyRxkKC1YrH5Y7DKUXGPFqjJBoXYq7IbQH"
  //     );

  //     formInfo = `JurisdictionId4=&JurisdictionId1=&JurisdictionId2=&JurisdictionId3=&JurisdictionId5=${
  //       process.data.VISA_META.jurisdictionData.find((e) => e.Value.includes(visaTypeParams.location))?.Id
  //     }&loc1=&loc2=&loc3=&loc4=&loc5=&`;

  //     formInfoBaseScriptDataIndexes = [1, 3, -1, 5, 5, 5, 5];
  //   } else {
  //     scriptDataEncoded = encodeURIComponent(
  //       "jo+WrPiNo78ZDGuNpLOXpGPkRY1WOVNLq38DovBlGIXNk0RfKBImxgQ8QoEMNKRvGQu4ocumvycNeaXpRnh+tbP0KBwjS8ewtB8bNn0bv9VLJ/WNu8KXtCWJ6Zwf8TuOjTMgRbub07pXh9eFrJLXJCKnGI5gI16rf5GB7OERbRfdR3H9LujDj3H64G60/eSKrpknKN2ThwV/3rJjdp/kzc781BWwMDKbnuxcMMNmhrPxmVizCkm+z7G7fouVdXzKkx9B3R0GkC6r+VXosVuh37JIMgC1wngLlC0dciwPyd988lUMmpF+8GSBXEm5Rh3Xxx08BGWXGUwkSD2IpPXgx7kF8Hcx2SFA8OnyWGZF2Lg="
  //     );

  //     formInfoBaseScriptDataIndexes = [3, 2, 2, 3, 3, 3, 3];
  //     formInfoBaseCustomFillers[formInfoBase.indexOf("AppointmentFor")] = (e) => "Individual";
  //   }

  //   for (const formInfoBaseElement of formInfoBase) {
  //     for (const number of [1, 2, 3, 4, 5]) {
  //       let val = "";
  //       const formBaseElementIndex = formInfoBase.indexOf(formInfoBaseElement);
  //       if (formInfoBaseCustomFillers[formBaseElementIndex]) {
  //         val = formInfoBaseCustomFillers[formBaseElementIndex](number);
  //       }

  //       if (formInfoBaseScriptDataIndexes[formBaseElementIndex] === number || formInfoBaseScriptDataIndexes[formBaseElementIndex] === -1) {
  //         val = formInfoBaseValues[formBaseElementIndex];
  //       }

  //       formInfo += `${formInfoBaseElement}${number}=${val}&`;
  //     }
  //   }

  //   const idsRegex = /<input[^>]*name=["']?(Id\d{0,2})["']?[^>]*value=["']?([^"']+)["']/gi;

  //   for (const match of html.matchAll(idsRegex)) {
  //     const idName = match[1];
  //     const idValue = match[2];

  //     process.vars["VT_IDS_" + idName] = idValue;

  //     formInfo += `${idName}=${idValue}&`;
  //   }

  //   let rd = JSON.stringify(
  //     VTWork.generateRspd({
  //       loc: formInfoBaseScriptDataIndexes[formInfoBase.indexOf("Location")],
  //       vType: formInfoBaseScriptDataIndexes[formInfoBase.indexOf("VisaType")],
  //       vSubType: formInfoBaseScriptDataIndexes[formInfoBase.indexOf("VisaSubType")],
  //       miss: formInfoBaseScriptDataIndexes[formInfoBase.indexOf("Mission")],
  //       apci: formInfoBaseScriptDataIndexes[formInfoBase.indexOf("AppointmentCategoryId")],
  //       ani: formInfoBaseScriptDataIndexes[formInfoBase.indexOf("ApplicantsNo")],
  //       m: visaTypeParams.mission,
  //       a: parseInt(visaTypeParams.applicants_no),
  //     })
  //   );

  //   const rvt = (Regexes.input_RVT.exec(html) || [])[1];
  //   assert(rvt, `[booker, vt] vt failed, rvt not found`);

  //   const cd = (Regexes.input_("CaptchaData").exec(html) || [])[1];
  //   assert(cd, `[booker, vt] vt failed, cd not found`);

  //   return `${formInfo}CaptchaData=${encodeURIComponent(decodeHtmlEntities(cd))}&ScriptData=${scriptDataEncoded}&ResponseData=${encodeURIComponent(
  //     rd
  //   )}&__RequestVerificationToken=${encodeURIComponent(rvt)}&X-Requested-With=XMLHttpRequest`;
  // }
}

Regexes = class {
  static form_action = /<form[^>]*\saction\s*=\s*["']([^"']*)["'][^>]*>/;
  static input_RVT = /<input[^>]*name=["']?__RequestVerificationToken["']?[^>]*value=["']?([^"']+)["']/i;
  static input_Id = /<input[^>]*name=["']?Id["']?[^>]*value=["']?([^"']+)["']/i;
  static captcha_submit_blocked_FOR = new RegExp("Please wait (\\d+) minute.s. to submit again");

  static captcha_submit_blocked_MAX = new RegExp("You have reached maximum number of captcha");

  static object_key_value = (key) => new RegExp(`['"]?${key}["']? *: *['"](.+?)['"](?:,|\n|\r)`, "s");

  static captcha_url_regex = /iframeOpenUrl *= *["']([^'"]+)/;
  static captcha_action_extract = /<form[^>]*\saction\s*=\s*["']([^"']*)["'][^>]*>/;
  static vtvURL = /href=["']([^"']+)["']\s*>\s*Book New Appointment\s*<\/a>/im;

  static availDates = /availDates\s*=\s*(.+?)(?:;|\n|\r)/s;

  static locationData = /locationData *= *(.*?)(?:;|var|<)/s;
  static visaIdData = /(?:visaIdData|visaTypeData) *= *(.*?)(?:;|var|<)/s;
  static visasubIdData = /visasubIdData *= *(.*?)(?:;|var|<)/s;
  static applicantsNoData = /applicantsNoData *= *(.*?)(?:;|var|<)/s;
  static missionData = /missionData *= *(.*?)(?:;|var|<)/s;
  static jurisdictionData = /jurisdictionData *= *(.*?)(?:;|var|<)/s;
  static categoryData = /(?:categoryData|AppointmentCategoryIdData) *= *(.*?)(?:;|var|<)/s;

  static countryData = /countryData *= *(.*?)(?:;|var|<)/s;
  static genderData = /genderData *= *(.*?)(?:;|var|<)/s;
  static maritalStatusData = /maritalStatusData *= *(.*?)(?:;|var|<)/s;
  static journeyPurposeData = /journeyPurposeData *= *(.*?)(?:;|var|<)/s;
  static passportTypeData = /passportTypeData *= *(.*?)(?:;|var|<)/s;
  static relationshipData = /relationshipData *= *(.*?)(?:;|var|<)/s;

  static availDates = /availDates *= *(.*?)(?:;|var|<)/s;

  static pageTitle = /<title>([^<]+)<\/title>/s;

  static var_val(name, body, nodeclaration = false) {
    return (new RegExp(`${nodeclaration ? "" : "(?:var|const|let) *"}${name} *= *(.*?)(?:;|var|<)`, "s").exec(body) || [])[1];
  }

  static manappdata(str) {
    return {
      countryData: Regexes.get("countryData", str),
      genderData: Regexes.get("genderData", str),
      maritalStatusData: Regexes.get("maritalStatusData", str),
      journeyPurposeData: Regexes.get("journeyPurposeData", str),
      passportTypeData: Regexes.get("passportTypeData", str),
      relationshipData: Regexes.get("relationshipData", str),
    };
  }

  static visadata(str) {
    let locationdata;
    if (process.vars.COUNTRY === "algeria") {
      let alllocsreg = /var *(\w+?) *= *\[\{"Id/g;
      let alllocs = [];
      console.log("finding locs");
      do {
        let alllocsexec = alllocsreg.exec(str);
        if (alllocsexec) {
          alllocs.push(alllocsexec[1]);
          console.log(alllocs);
        } else {
          break;
        }
      } while (true);
      console.log("all locs", alllocs);
      alllocs = alllocs.filter((e) => !["visasubIdData", "visaIdData", "applicantsNoData", "categoryData"].includes(e));
      let maxcount = 0;
      let maxvarname = "";
      for (const varname of alllocs) {
        let count = str.split(varname).length - 1;
        if (count > maxcount) {
          maxcount = count;
          maxvarname = varname;
        }
      }
      console.log("max loc", maxvarname);
      locationdata = Regexes.var_val(maxvarname, str);
    } else {
      locationdata = Regexes.get("locationData", str);
    }
    return {
      locationData: locationdata,
      visaIdData: Regexes.get("visaIdData", str),
      visasubIdData: Regexes.get("visasubIdData", str),
      applicantsNoData: Regexes.get("applicantsNoData", str),
      missionData: Regexes.get("missionData", str) || "[]",
      jurisdictionData: Regexes.get("jurisdictionData", str) || "[]",
      categoryData: Regexes.get("categoryData", str) || "[]",
    };
  }

  static input_(name) {
    return new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']?([^"']+)["']`);
  }
  static input_byid_(name) {
    return new RegExp(`<input[^>]*id=["']${name}["'][^>]*value=["']?([^"']+)["']`);
  }

  static get(regex, string) {
    return (Regexes[regex].exec(string) || [])[1];
  }

  static val(name, string) {
    return (Regexes.input_(name).exec(string) || [])[1];
  }

  static val_byid(name, string) {
    return (Regexes.input_byid_(name).exec(string) || [])[1];
  }
};

class FormData {
  static login(email, pass, caid, cada, rvt) {
    return FormData.encode([
      ["UserId1", ""],
      ["UserId2", ""],
      ["UserId3", ""],
      ["UserId4", ""],
      ["UserId5", email],
      ["UserId6", ""],
      ["UserId7", ""],
      ["UserId8", ""],
      ["UserId9", ""],
      ["UserId10", ""],
      ["Password1", ""],
      ["Password2", ""],
      ["Password3", ""],
      ["Password4", ""],
      ["Password5", ""],
      ["Password6", ""],
      ["Password7", pass],
      ["Password8", ""],
      ["Password9", ""],
      ["Password10", ""],
      ["ReturnUrl", ""],
      ["CaptchaId", caid],
      ["CaptchaParam", ""],
      ["CaptchaData", cada],
      ["ScriptData", "S65Dmek/USX8/ijsaahdDiZk2pdjgDy1QzC4MALdTelLjpzcKgAqLJPqhbDt6U4sxmGELR7t15CX7+PABrGWPivPxq0bvFgKB7AnQg1MOuFTwXxmR7mRshKKDPUca41ulkkl5Z5B5Iys2oCJEbCFWQ=="],
      ["__RequestVerificationToken", rvt],
      ["X-Requested-With", "XMLHttpRequest"],
    ]);
  }

  static captcha_bypass(rvtforcap) {
    return FormData.encode([
      ["SelectedImages", "mevyvylb,uoqyc,vklzfabcj,xjmznq"],
      ["Id", "89f96f36-4d48-4931-8920-4de11f74adaf"],
      [
        "Captcha",
        "Bf0KU6r4PHzEtR9My6uzzPdKSddwylXruf9ExVC2AqwgiR5ycEqqKD0n6sTVxpXFAMEiyxKbKypeIJeRKluBctR3LnnxxPJy2rnOI+vCTXd/dFEObgxYW8YwyGW58oGBY3+nQ87uJvgs3HZgc+ZOft1fFK82dImahOv4G4ZaWzOqa/P/5MCDtejXzT9Oz0ZR7ADLJ6J+MzD2LrB8OZpKBsr5JdNjSEfcIQHHX2aY/c4Ax+Xw+FLWvYTC4N6oeceaAWvVATxJpBxADKkI79Ltu0o1Mw6cF2lgS8IwQsXuzLTQYCnRbl7D1dh8O556BQackiPdUnRtfWHbsnpXSESSH/JfofZ/kIZak4qxQ6+Bthlxsg6H2hVJx+44GdBwkoDN4V7E47kPAlSRiZtJUzoyozyG8rvqKeXwbucRyLBywkte2srjfD0rRpWdJ4LBpkI6P10GBCuRQC2c13GL2RQH8PPrfdIVs6MuEDLhktzfUO1LWg0E4lMtEpC44hcydqhL680ho2HFM2DDrf7x41PZE07Z4ZcnQrnrkC3HG98ukQY73KHKJnrCR8698RN0nVE43Cdenplq1BHAO0uKDbFaxXlAfR3pmDRoFYOoZeNZ9ZUD18UtRl+G62Ng2DE/mN0N+MNUOEYM1G96SvqDFx644Ud4cp6ecvF1FkCg0tMszDjP5vUwnkd8cNgYlnOGFWOpz4pW9kaGe05khy3YtBTD48J4+CxTpPAauoQvcr7zfumEYYNDFWKxh6SD0NHAiBu/EQW2Xq5tgSDVD8P4NKvIE4dcge2JUpckYCe1CfLsZbQBGbaxVr9vEFvZ0XXWIivBxJGPwwmJQ8et1pZ8YxQoDaFOIxy79yL/o8j9+OX7DNkUe6I6gTbC+AccQMplOBppzGhmgaDw3ZwZ1rW12rGu4R0lDEgXw+Gq/2A/k79UEIpBAri2XAb6nS7p3PrTRnxEwRHxSbsdLTzft4KNSMV6Z+CUzlV+qK+ar4FyIcWmXfHVA2sn4x6VFbpThzOcxHqpB7v0Vjw8KD3G0vngqWCF2IQ7wRFQovBHvNLaFWDtIDXLwoarAErvyPlBeOdJGuPu5TcGmOjoMsYzatWvT8UE72HGQDl2m1HIjRi4K4NS2LvEo1V+CBOuDpbXQTeHW+PjL4y4obVXnyUVXm9yg10s96DYHskLpJ6lMMYf+k7Xj7MFqU385XkatLEpOL3qwTOtlZh9+SQxFUw408yRH3UysvT0q+0DEWgVsqCiICzb45iBn0LDpZudwB8K4470TkyeMUFSFmiNRxHUupO9EmiElzXvNEUhP+AnlxqO0TpobfdKjroglvz6vUljttXMDFjYjXIPc3OPzkmTCGd9lC2Kq6n0l9rRG64qFEmIjeOKBD/ojBvaIhnst5xhnF8rVFzyoxdjoXiYxYZqwzysrGdo4ynvvbBgvaTmVdF/zJyQi3c/4mXq5kOO/vr4Wv4e4a0eQ67EFsrgXz50ISWyMIb9cpWneP1dYQ4t2cLxRrdQMx3Gmlc3Qu7yJNFpVVC8HLkcTlvU6AJG2P3C5BXrLjxnq0oA79agrmQqyYvNpiNYZbalz3AJNdgDVFL58X8XD2vBd5tBNq6WxtZTYAOk/IpY1FZ7ilH0g4c/G3le31fYeiWDWQKlgJF+WTXp/zK8xoWezMbNrGiKbubyUqedLE43zGBmbDSN2Rj2eQmlvHSTHaWpha1Mjc8z+MyLclQrAHEbe5rQnpVfYW+L/m1HKcqbt+jp9wcnhiryNiWNusst+TnT75w99tFddQpCm/r4bohJ8XkhytTt1gD0QNacWB6kDdWtxx4XgLXUWluQBto6idLdHFhwm6pgQkiiJPTaVpqZ6fnUnqppqatkQMagraxZ7/UNADuspDwwvnTJCCb1kYGGrySRH1V9CAPx/uaaOsMC5BiFZTNLX9Cg2E7vCjWDDIHuUri33iUvfNEwzFtpD6QZ4voM6c08BCXndVMa1jSh1Y50y23UsZofqI3McLcSGLkkyqAVO0aTPaG1O09nyB8=",
      ],
      ["__RequestVerificationToken", rvtforcap],
      ["X-Requested-With", "XMLHttpRequest"],
    ]);
  }

  static captcha_form_elements(selectedImages, id, rvt, captcha) {
    let arr = [
      ["SelectedImages", selectedImages],
      ["SelectedImages", ""],
      ["Id", id],
      ["__RequestVerificationToken", rvt],
    ];
    if (captcha) arr.push(["Captcha", captcha]);
    return arr.reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
  }

  static captcha(selectedImages, id, rvt, captcha) {
    let arr = [
      ["SelectedImages", selectedImages],
      ["SelectedImages", ""],
      ["Id", id],
      ["__RequestVerificationToken", rvt],
    ];
    if (captcha) arr.push(["Captcha", captcha]);
    return FormData.encode(arr);
  }

  static visatypeverification(rvt, CaptchaData) {
    return FormData.encode([
      ["CaptchaData", CaptchaData],
      ["__RequestVerificationToken", rvt],
    ]);
  }

  static visatype(html) {
    return VTWork.form_data(html);
  }

  static encode_object(obj) {
    return Object.keys(obj)
      .map((key) => {
        return `${key}=${encodeURIComponent(obj[key])}`;
      })
      .join("&");
  }

  static encode(arr) {
    return arr
      .map((e) => {
        return e[0] + "=" + encodeURIComponent(e[1]);
      })
      .join("&");
  }
}

class Email {
  static async getCode(mark) {
    return require("./mail").getRecentOTP(process.vars.EMAIL, undefined, mark);
  }

  static async getDataProtectionLink(mark) {
    return require("./mail").getRecentDataProtectionLink(process.vars.EMAIL, undefined, mark);
  }
}

function extract_alert_message(body) {
  let reason;
  const bodypart1 = body.split(/alert (?:alert-danger|alert-warning)["'][^>]*>/)[1];
  if (bodypart1) reason = bodypart1.split("</div>")[0].trim();

  return reason;
}

function save_errorCodes(body, url) {
  if (!url.includes("err=") && !url.includes("msg=")) return;

  let reason;

  const params = new URLSearchParams(url.split("?")[1]);
  const errCode = params.get("err") || params.get("msg");
  const bodypart1 = body.split(/alert (?:alert-danger|alert-warning)["'][^>]*>/)[1];
  if (bodypart1) reason = bodypart1.split("</div>")[0].trim();

  if (!reason) {
    let bodypart1_summ = body.split(/validation-summary-errors[^>]+?>/)[1];
    if (bodypart1_summ) bodypart1_summ = bodypart1_summ.split("</div>")[0].trim();
    if (bodypart1_summ) reason = bodypart1_summ.split("</div>")[0].trim();
    reason = reason?.replace(/<[^>]+?>/g, "").trim();
  }

  if (reason) {
    try {
      const errorcodes = require("./errorcodes.json");
      if (!errorcodes[errCode]) {
        uiapi.reporterrorcode({ errCode, reason }).catch((e) => console.log("error while reporting errorcode", e));
      }
    } catch (e) {
      console.log("can't save code", e, "code is", errCode, reason);
    }

    return reason;
  } else {
    process.dynamic.EE.emit("info", "utils", "can't extract error");
  }
}

function check_disconnect(response, ret) {
  if (response.statusCode === 401 || (response.statusCode === 302 && response.headers.location?.toLowerCase().includes(process.vars.LOGIN_URL?.toLowerCase()))) {
    process.vars.LOGIN_URL_REDIRECT = response.headers.location;
    if (process.vars.PASSBYFORM) process.vars.PASSBYFORM = 0;
    process.dynamic.EE.emit("info", "utils", "disconnected: statusCode: " + response.statusCode);
    if (ret) return "disconnected";

    process.dynamic.EE.emit("done", "disconnected");
    throw new Error("disconnected");
  } else if (response.statusCode === 400) {
    process.vars.LOGIN_TO_CALENDAR = undefined
    process.dynamic.EE.emit("info", "utils", "badrequest: statusCode: " + response.statusCode);
    if (ret) return "disconnected: badrequest";

    process.dynamic.EE.emit("done", "badrequest");
    throw new Error("badrequest: disconnected");
  }
}

function log_and_exit(reason, doawait) {
  if (process.dynamic?.log_and_exit) return process.dynamic.log_and_exit(reason, doawait);
  else {
    console.log("exiting, reason:", reason);
    process.exit(1);
  }
}

async function block_execution() {
  await new Promise((resolve) => { });
}

function inter_verification_timeout() {
  if (process.vars.appoitnment_checks === undefined) process.vars.appoitnment_checks = 0;
  process.vars.appoitnment_checks++;

  let TIMEOUT = process.env.INTER_VERIFICATION_TIMEOUT
  if (process.vars.COUNTRY == "moroccopt") TIMEOUT = process.env.INTER_VERIFICATION_TIMEOUT_PT || TIMEOUT


  if (process.vars.COUNTRY == "algeria") {
    if (TIMEOUT) return parseInt(TIMEOUT);
    if (process.vars.appoitnment_checks == 1) {
      return 3000;
    } else if (process.vars.appoitnment_checks == 2) {
      return 10000;
    } else if (process.vars.appoitnment_checks == 3) {
      process.vars.appoitnment_checks = 0;
      return 15000;
    }
  } else if (TIMEOUT) return parseInt(TIMEOUT);

  if (process.vars.appoitnment_checks < 3) {
    return 1000;
  } else if (process.vars.appoitnment_checks < 6) {
    return 5000;
  } else if (process.vars.appoitnment_checks < 9) {
    return 15000;
  } else {
    process.vars.appoitnment_checks = 0;
    return 20000;
  }
}

function get_country_center_from_visa(visa) {
  let country = [],
    center = [];
  const defaults = require("../prerun/defaults.json");

  Object.keys(defaults.centers).find((centerCountry) => {
    for (const centerKey in defaults.centers[centerCountry]) {
      if (defaults.centers[centerCountry][centerKey].includes(visa)) {
        country.push(centerCountry);
        center.push(centerKey);
      }
    }
  });

  return { center, country };
}

function get_country_from_center(center) {
  const defaults = require("../prerun/defaults.json");

  let countries = Object.keys(defaults.centers).filter((centerCountry) => {
    return center in defaults.centers[centerCountry];
  });

  return countries;
}

function get_visa_info_from_id(visainfoid) {
  const defaults = require("../prerun/defaults.json");
  return defaults.visa_types[visainfoid];
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function info(source, message) {
  process.dynamic.EE.emit("info", source, message);
}

function done(source) {
  process.dynamic.EE.emit("done", source);
}

async function statecheck(wait_time = 0, check_interval = 1000, info = {}) {
  while (process.env.PAUSE) {
    await wait(1000);
  }
  if (wait_time) {
    let totalWaitTime = 0;
    while (true) {
      if (check()) break;
      await wait(check_interval);
      totalWaitTime += check_interval;
      if (totalWaitTime > wait_time) break;
    }
  } else {
    check();
  }

  function check() {
    if (info.freeing_passport || info.in_calendar) return true;
    if (process.env.IS_FREEING_PASSPORT && !info.in_calendar) {
      done("any_freepassport");
      throw new Error("ignore");
    } else if (process.vars.CALENDAR_ON_SIGNAL && Date.now() - process.vars.CALENDAR_ON_SIGNAL > parseInt(process.env.CALENDAR_ON_SIGNAL_TIMEOUT || 7000)) {
      process.vars.CALENDAR_ON_SIGNAL = undefined;
      return true;
    }
  }
}

function classify_error_from_url(location) {
  let error_code = get_error_param_from_url(location);

  if (error_code.includes("OEU9NjFOL6HzJluryt4ZlQYFahO63QN6fBC0")) {
    return "invalid_req";
  } else if (error_code.includes("I8fzwcs")) {
    return "max_req";
  } else if (error_code.includes("9NqNa27GWQ9FvyH58OoM1VqK")) {
    return "max_req2";
  } else if (error_code.includes("wpudqebo0oqbnnlt8bsytudq")) {
    return "invalid_param2";
  } else if (error_code.includes("kjbpmKBTOgC0ROr5plfvIh")) {
    return "invalid_flow";
  } else if (error_code.includes("wpudqebo0oqbnnlt8bsytbbrw")) {
    return "invalid_param";
  } else if (error_code.includes("HU7zqU0yCxX3GNnx4emgb8d")) {
    return "network_changed";
  } else if (error_code.includes("rWncsYR2o")) {
    return "err_occured";
  } else if (error_code.includes("GzBaAQVEqKUJ2Hg1yNEy2fvOxjFQmelEKM")) {
    return "invalid_app_req";
  } else if (error_code.includes("ZokWWxtCWRl2wwydQeR8iMSec")) {
    return "no_slots";
  } else if (error_code.includes("2cTxdW4MmqAwBEZbP")) {
    return "invalid_data";
  } else if (error_code.includes("S7Lsv591MgBwOTO")) {
    return "app_req_expired";
  } else if (error_code.includes("lfJQVX2NULaGjPKL6fTAx8OwQ40JPWxyVNRzenfsl9Cp")) {
    return "invalid_param_format";
  }

  return error_code || "no_error_code";
}

function get_error_param_from_url(url) {
  if (!url?.includes("?")) return "";

  try {
    const params = new URLSearchParams(url.split("?")[1]);
    return params.get("err") || params.get("msg") || params.get("message") || params.get("error") || "";
  } catch (e) {
    return "";
  }
}

function check_error_and_exit(location, work) {
  let errocode = get_error_param_from_url(location);
  if (errocode) {
    throw new Error("error code in " + work + ": " + errocode);
  } else {
    let urlpath = location?.split("?")[0] || "";
    let urllastpart = urlpath.split("/").pop();
    throw new Error("bad redirect in " + work + ": " + urllastpart);
  }
}

async function sendTelegramMessage(text, BOT_TOKEN = process.env.BOT_TOKEN, CHAT_IDS = process.env.CHAT_ID) {
  let chat_ids = CHAT_IDS?.split(",").map((e) => e.trim());
  for (const CHAT_ID of chat_ids) {
    if (!BOT_TOKEN || !CHAT_ID) console.log(`can't send telegram message, token chatid: ${BOT_TOKEN} ${CHAT_ID}`);

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const params = { chat_id: CHAT_ID, text, parse_mode: "HTML" };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });

      const data = await response.json();
      console.log(data);
    } catch (error) {
      console.error("Error sending message:", error);
    }
  }
}
async function ipfetcher(httpManager) {
  let ip_;

  function ipfetcher1() {
    return httpManager
      .get_("https://api.ipify.org/")
      .then((r) => {
        if (r.status == 200) return r.body;
        else if (!ip_) return ipfetcher1();
      })
      .catch(() => {
        if (!ip_) return ipfetcher1();
      });
  }

  function ipfetcher2() {
    return httpManager
      .get_("https://ifconfig.me/ip")
      .then((r) => {
        if (r.status == 200) return r.body;
        else if (!ip_) return ipfetcher2();
      })
      .catch(() => {
        if (!ip_) return ipfetcher2();
      });
  }

  function ipfetcher3() {
    return httpManager
      .get_("https://ifconfig.co/ip")
      .then((r) => {
        if (r.status == 200) return r.body;
        else if (!ip_) return ipfetcher3();
      })
      .catch(() => {
        if (!ip_) return ipfetcher3();
      });
  }

  await new Promise((resolve, reject) => {
    ipfetcher1().then((ip) => {
      ip_ = ip;
      resolve();
    });
    setTimeout(() => {
      if (!ip_)
        ipfetcher2().then((ip) => {
          ip_ = ip;
          resolve(ip);
        });
    }, 3000);
    setTimeout(() => {
      if (!ip_)
        ipfetcher3().then((ip) => {
          ip_ = ip;
          resolve(ip);
        });
    }, 5000);
  });

  ip_ = ip_
    ?.split("")
    .filter((e) => ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "."].includes(e))
    .join("");

  console.log("ip got", ip_);

  return ip_;
}

const grecaptchakeys = {
  'algeria': "6Ldkm4UrAAAAADAFSmvv1au-CN9RDlbjV82ws_Hb",
  'morocco': "6LdrjYYrAAAAAOGQEnm-R9r9OzsZBNGfgJj8BVuy"
}
const vttitles = {
  'algeria': "Algeria BLS Spain Visa: Welcome to the Official Website Spain Visa Application Centre in Algeria",
  'morocco': "Morocco BLS Spain Visa: Welcome to the Official Website Spain Visa Application Centre in Morocco"
}

async function getReCaptchaToken3({ action, url }) {
  if (url.startsWith("/")) url = process.vars.BASE_URL + url.substring(1)
  else url = process.vars.BASE_URL + url

  let proxyparts = process.vars.PROXY_IN_USE?.split(":")
  let task = {
    "clientKey": process.env.TWOCAPTCHA_API_KEY,
    "task": {
      "type": "RecaptchaV3TaskProxyless",
      "websiteURL": url,
      "websiteKey": grecaptchakeys[process.vars.COUNTRY],
      "isInvisible": false,
      "pageAction": action,
      "userAgent": process.vars.userAgent,
      "minScore": 0.9,
      isEnterprise: false
      // proxyType: 'http',
      // proxyAddress: proxyparts[0],
      // proxyPort: proxyparts[1],
      // proxyLogin: proxyparts[2],
      // proxyPassword: proxyparts[3]
    }
  }

  return fetch("https://api.2captcha.com/createTask", {
    method: "POST",
    body: JSON.stringify(task),
    headers: {
      "Content-Type": "application/json"
    }
  }).then(res => res.json()).then(data => {
    let taskid = data?.taskId
    console.log(JSON.stringify(data, null, 2))

    if (taskid) {
      return new Promise((resolve, reject) => {
        let interval = setInterval(() => {
          fetch(`https://api.2captcha.com/getTaskResult`, {
            method: "POST",
            body: JSON.stringify({
              clientKey: process.env.TWOCAPTCHA_API_KEY,
              taskId: taskid
            }),
            headers: {
              "Content-Type": "application/json"
            }
          }).then(res => res.json()).then(data => {
            if (data?.status === "ready") {
              clearInterval(interval)
              console.log('grecaptcha token === grecaptcha response', data?.solution?.gRecaptchaResponse === data?.solution?.token)
              console.log(data)
              console.log('token length', data?.solution?.gRecaptchaResponse?.length)
              resolve(data?.solution?.gRecaptchaResponse)
            } else if (data?.status !== "processing") {
              console.log('grecaptcha token not ready', data)
              clearInterval(interval)
              resolve(null)
            }
          })
        }, 3000)
      })
    }
  }).catch(e => {
    console.log('error getting grecaptcha token', e)
    return null
  })
}

async function getReCaptchaToken3({ action, url }) {


}

async function getReCaptchaToken2({ action, url }) {
  if (url.startsWith("/")) url = process.vars.BASE_URL + url.substring(1)
  else url = process.vars.BASE_URL + url

  let types = ["ReCaptchaV3TaskProxyLess", "ReCaptchaV3Task", "ReCaptchaV2TaskProxyLess", "ReCaptchaV2Task", "ReCaptchaV2EnterpriseTaskProxyLess", "ReCaptchaV2EnterpriseTask", "ReCaptchaV3EnterpriseTaskProxyLess", "ReCaptchaV3EnterpriseTask"]
  // let types = ["ReCaptchaV2TaskProxyLess", "ReCaptchaV2EnterpriseTask", "ReCaptchaV2EnterpriseTaskProxyLess"]
  let random = "ReCaptchaV2TaskProxyLess" || types[Math.floor(Math.random() * types.length)]

  let useproxy = random.includes("ProxyLess") ? false : true

  let apiDomains = ["http://www.google.com/", "http://www.recaptcha.net/"]
  let apiDomain = apiDomains[Math.floor(Math.random() * apiDomains.length)]


  let task =
  {
    clientKey: process.env.CAPSOLVER_API_KEY,
    "task": {
      type: random,
      websiteURL: decodeURIComponent(url),
      websiteKey: grecaptchakeys[process.vars.COUNTRY],
      pageAction: action,
      isInvisible: false,
      // apiDomain,
      userAgent: process.vars.userAgent
    }
  }

  // {
  //   type: random,
  //   websiteURL: url,
  //   websiteKey: "6Ldkm4UrAAAAADAFSmvv1au-CN9RDlbjV82ws_Hb",
  //   pageAction: action,
  //   isInvisible: true,
  //   apiDomain,
  //   userAgent: process.vars.userAgent
  // }

  if (useproxy) {
    task.task.proxy = "http:" + process.vars.PROXY_IN_USE
  }

  console.log('using type', random)
  console.log('using apiDomain', apiDomain)

  return fetch("https://api.capsolver.com/getToken", {
    method: "POST",
    body: JSON.stringify(task),
    headers: {
      "Content-Type": "application/json"
    }
  }).then(res => res.json()).then(data => {
    console.log('token length', data?.solution?.gRecaptchaResponse?.length)
    process.vars.GR_UA = data?.solution?.userAgent
    return data?.solution?.gRecaptchaResponse
  })
}

async function getReCaptchaToken({ action, url }) {

  if (url.startsWith("/")) url = process.vars.BASE_URL + url.substring(1)
  else url = process.vars.BASE_URL + url

  let task = {
    "referer": decodeURIComponent(url),
    "sitekey": grecaptchakeys[process.vars.COUNTRY],
    "size": "invisible",
    "title": vttitles[process.vars.COUNTRY],
    "action": "VisaType"
  }

  return fetch("http://api.nocaptcha.io/api/wanda/recaptcha/universal", {
    method: "POST",
    body: JSON.stringify(task),
    headers: {
      "Content-Type": "application/json",
      "User-Token": process.env.NOCAPIO_API_KEY
    }
  }).then(res => res.json()).then(data => {
    console.log(data)
    return data?.data?.token
  })
}

async function getReCaptchaToken4({ action, url }) {
  if (url.startsWith("/")) url = process.vars.BASE_URL + url.substring(1)
  else url = process.vars.BASE_URL + url

  let types = ["ReCaptchaV3TaskProxyLess", "ReCaptchaV3Task", "ReCaptchaV2TaskProxyLess", "ReCaptchaV2Task", "ReCaptchaV2EnterpriseTaskProxyLess", "ReCaptchaV2EnterpriseTask", "ReCaptchaV3EnterpriseTaskProxyLess", "ReCaptchaV3EnterpriseTask"]
  // let types = ["ReCaptchaV2TaskProxyLess", "ReCaptchaV2EnterpriseTask", "ReCaptchaV2EnterpriseTaskProxyLess"]
  let random = "ReCaptchaV2TaskProxyLess" || types[Math.floor(Math.random() * types.length)]

  let useproxy = random.includes("ProxyLess") ? false : true

  let apiDomains = ["http://www.google.com/", "http://www.recaptcha.net/"]
  let apiDomain = apiDomains[Math.floor(Math.random() * apiDomains.length)]


  let task =
  {
    clientKey: process.env.CAPSOLVER_API_KEY,
    "task": {
      type: random,
      websiteURL: decodeURIComponent(url),
      pageUrl: decodeURIComponent(url),
      websiteKey: grecaptchakeys[process.vars.COUNTRY],
      pageAction: action,
      isInvisible: false,
      isinvisible: false,
      invisible: false,
      // apiDomain,
      userAgent: process.vars.userAgent
    }
  }

  // {
  //   type: random,
  //   websiteURL: url,
  //   websiteKey: "6Ldkm4UrAAAAADAFSmvv1au-CN9RDlbjV82ws_Hb",
  //   pageAction: action,
  //   isInvisible: true,
  //   apiDomain,
  //   userAgent: process.vars.userAgent
  // }

  if (useproxy) {
    task.task.proxy = "http:" + process.vars.PROXY_IN_USE
  }

  console.log('using type', random)
  console.log('using apiDomain', apiDomain)

  return fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    body: JSON.stringify(task),
    headers: {
      "Content-Type": "application/json"
    }
  }).then(res => res.json()).then(data => {
    if (!data?.taskId) return null

    return new Promise((resolve, reject) => {
      let interval = setInterval(() => {
        fetch(`https://api.capsolver.com/getTaskResult`, {
          method: "POST",
          body: JSON.stringify({
            clientKey: process.env.CAPSOLVER_API_KEY,
            taskId: data?.taskId
          }),
          headers: {
            "Content-Type": "application/json"
          }
        }).then(res => res.json()).then(data => {
          if (data?.status === "ready") {
            clearInterval(interval)
            console.log('grecaptcha token === grecaptcha response', data?.solution?.gRecaptchaResponse === data?.solution?.token)
            console.log(data)
            console.log('token length', data?.solution?.gRecaptchaResponse?.length)
            resolve(data?.solution?.gRecaptchaResponse)
          } else if (data?.status !== "processing") {
            console.log('grecaptcha token not ready', data)
            clearInterval(interval)
            resolve(null)
          }
        })
      }, 3000)
    })
  })
}

module.exports = {
  ipfetcher,
  sendTelegramMessage,
  get_visa_info_from_id,
  ProxyManager,
  HTTPManager,
  CaptchaSolver,
  decodeHtmlEntities,
  findFunctionBodyInHTML,
  Regexes,
  FormData,
  Email,
  LoginSolver,
  visaMeta,
  Captcha,
  VTSolver,
  VTWork,
  CalendarSolver,
  save_errorCodes,
  extract_alert_message,
  check_disconnect,
  log_and_exit,
  block_execution,
  get_country_from_center,
  wait,
  get_country_center_from_visa,
  inter_verification_timeout,
  info,
  done,
  statecheck,
  classify_error_from_url,
  get_error_param_from_url,
  check_error_and_exit,
  getReCaptchaToken
};

function visaMeta(country) {
  var locationDataMar = [
    {
      Id: "60d2df036755e8de168d8db7",
      Name: "Casablanca",
      Code: "CASABLANCA",
    },
    {
      Id: "0566245a-7ba1-4b5a-b03b-3dd33e051f46",
      Name: "Nador",
      Code: "NADOR",
    },
    {
      Id: "8d780684-1524-4bda-b138-7c71a8591944",
      Name: "Rabat",
      Code: "RABAT",
    },
    {
      Id: "889689b5-1099-4795-ac19-c9263da23252",
      Name: "Tetouan",
      Code: "TETOUAN",
    },
    {
      Id: "8457a52e-98be-4860-88fc-2ce11b80a75e",
      Name: "Tangier",
      Code: "TANGIER",
    },
    {
      Id: "138660df-f645-488f-8458-97186b17c7f9",
      Name: "Agadir",
      Code: "AGADIR",
    },
  ];
  var AppointmentCategoryIdDataMar = [
    {
      Id: "5c2e8e01-796d-4347-95ae-0c95a9177b26",
      Name: "Normal",
      Code: "CATEGORY_NORMAL",
    },
    {
      Id: "37ba2fe4-4551-4c7d-be6e-5214617295a9",
      Name: "Premium",
      Code: "CATEGORY_PREMIUM",
    },
    {
      Id: "0ec883de-84f4-4474-ae60-572e675873cb",
      Name: "Prime Time",
      Code: "PRIME_TIME",
    },
  ];
  var visaIdDataMar = [
    {
      Id: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Name: "National Visa",
      VisaTypeCode: "NATIONAL_VISA",
      AppointmentSource: null,
    },
    {
      Id: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
    },
    {
      Id: "c6c05a56-38d7-4929-8b3d-77a2280d9c20",
      Name: "Casa 1 ",
      VisaTypeCode: "SCHENGEN_VISA_CASA_ONE",
      AppointmentSource: "WEB_BLS",
    },
    {
      Id: "5e43f8e9-cb93-42f6-8350-9d8e2e79a42d",
      Name: "Casa 2",
      VisaTypeCode: "SCHENGEN_VISA_CASA_TWO",
      AppointmentSource: "WEB_BLS",
    },
    {
      Id: "889bd811-ae40-4507-93f3-cc1486c0f282",
      Name: "Casa 3",
      VisaTypeCode: "SCHENGEN_VISA_CASA_THREE",
      AppointmentSource: "WEB_BLS",
    },
  ];
  var visasubIdDataMar = [
    {
      Id: "ab828ce6-d1b3-46e0-8e91-8ffa27d2b6d7",
      Name: "Schengen Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "ccd817eb-c023-4eff-aac9-f6c394e7427f",
      Name: "Student Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "fbf41aee-a425-46fa-a0a7-2b9845ac8b0c",
      Name: "Family Reunification Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "ec498f00-5a86-4b2e-bca7-7a6b5b8b1d52",
      Name: "National Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_EMBASSY",
    },
    {
      Id: "0c6445de-03f8-4a52-92ae-a3f647e6644c",
      Name: "Work Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "ef92eec6-db32-437b-9291-0ee746b5a03b",
      Name: "Casa 1",
      Value: "c6c05a56-38d7-4929-8b3d-77a2280d9c20",
      Code: "WEB_BLS",
    },
    {
      Id: "4792c812-5088-4044-b13b-6abb4a0fa5bf",
      Name: "Casa 2",
      Value: "5e43f8e9-cb93-42f6-8350-9d8e2e79a42d",
      Code: "WEB_BLS",
    },
    {
      Id: "8b6f8ee2-d516-49fe-be38-226a1bd6d97e",
      Name: "Casa 3",
      Value: "889bd811-ae40-4507-93f3-cc1486c0f282",
      Code: "WEB_BLS",
    },
    {
      Id: "c7b597ed-983d-43d1-bac9-11ec85e6a821",
      Name: "Students - Language/selectivity",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "75d3f3cf-865f-4c42-b5c4-056bd3b1ec1e",
      Name: "Students - Non-tertiary studies",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "5f58d00d-d807-49a8-8f2d-ce4c60d96182",
      Name: "Students - Graduate studies",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "6d3bf398-debe-4d63-914e-fbadf7d4882e",
      Name: "Student - Others",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
  ];
  var missionDataMar = [
    {
      Id: "beae2d19-89a9-46e7-9415-5422adafe619",
      Name: "Consulate - Casablanca",
      Code: "CONSULATE_CASABLANCA",
    },
    {
      Id: "33f113d1-fa23-4292-b865-393675093998",
      Name: "Consulate - Tetouan",
      Code: "CONSULATE_TETOUAN",
    },
    {
      Id: "2c64c42a-1359-437a-9257-d8ad3f566e1a",
      Name: "Consulate - Nador",
      Code: "CONSULATE_NADOR",
    },
    {
      Id: "98a73e17-bf8f-41f2-933e-03e60b009327",
      Name: "Consulate - Rabat",
      Code: "CONSULATE_RABAT",
    },
    {
      Id: "d133459a-6482-45ed-bd00-5ff32aa8b71b",
      Name: "Consulate - Tangier",
      Code: "CONSULATE_TANGIER",
    },
    {
      Id: "4edec922-cd94-4955-9788-802269c9ff44",
      Name: "Consulate - Agadir",
      Code: "CONSULATE_AGADIR",
    },
  ];

  var locationDataDza = [
    {
      Id: "0566245a-7ba1-4b5a-b03b-3dd33e051f46",
      Name: "Algiers",
      Code: "ALGIERS",
    },
    { Id: "8457a52e-98be-4860-88fc-2ce11b80a75e", Name: "Oran", Code: "ORAN" },
  ];
  var AppointmentCategoryIdDataDza = [
    {
      Id: "5c2e8e01-796d-4347-95ae-0c95a9177b26",
      Name: "Normal",
      Code: "CATEGORY_NORMAL",
    },
    {
      Id: "37ba2fe4-4551-4c7d-be6e-5214617295a9",
      Name: "Premium",
      Code: "CATEGORY_PREMIUM",
    },
    {
      Id: "15044668-9bb4-477d-918b-4809370190b9",
      Name: "Prime Time",
      Code: "PRIME_TIME",
    },
  ];
  var visaIdDataDza = [
    {
      Id: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
      Name: "National Visa",
      VisaTypeCode: "NATIONAL_VISA",
      AppointmentSource: null,
    },
    {
      Id: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
    },
    {
      Id: "9d8b5d90-d9e6-454a-bd0a-1dd81878f0a9",
      Name: "Schengen visa ( Estonia)",
      VisaTypeCode: "SCHENGEN_VISA_ESTONIA",
      AppointmentSource: "WEB_BLS",
    },
  ];
  var visasubIdDataDza = [
    {
      Id: "b563f6e3-58c2-48c4-ab37-a00145bfce7c",
      Name: "Schengen Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "b563f6e3-58c2-48c4-ab37-a00145bfce7c1",
      Name: "Tourism",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "47d695af-787d-4460-ba79-ccc6f261fe73",
      Name: "Schengen visa ( Estonia)",
      Value: "9d8b5d90-d9e6-454a-bd0a-1dd81878f0a9",
      Code: "WEB_BLS",
    },
    {
      Id: "14e132e5-2f0a-40e1-833f-d0c862eb1899",
      Name: "Student Visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "4d774535-d05b-46bf-83bd-6b98d6d4fd2f",
      Name: "Researcher visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "e3a2e1b1-378e-4f6e-9adb-eacaec8d8ba8",
      Name: "Internship visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "eeb83923-5c8d-4458-9415-64451348c7dc",
      Name: "Family Reunification Visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "43a911df-f7f7-48f8-8dd8-59c65dce32b8",
      Name: "Residence and Employment Work Visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "aaff0199-6d71-4d97-ad45-908819db7fc3",
      Name: "Residence visa with working permit exemption",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "81ed5eb4-9b81-45b4-8df3-ad090286a619",
      Name: "Self-employed work visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "4757ce76-bc0b-4839-9af4-d9ea54363072",
      Name: "Investor visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "abdf02d9-80ae-4be9-b9f9-5d9e459c76a9",
      Name: "Entrepreneur visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "5205d0b9-0bae-42f2-aaf4-d441cdcdd7bb",
      Name: "Long-term residence visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "a2a5a09e-2a43-4d77-9b85-fdbc9920382d",
      Name: "Long-term residence or EU Long-term residence recover",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "dde5a936-4903-4965-b68c-da1383a13a70",
      Name: "Visa for highly qualified workers and for intra-company transfers",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "12f0c61f-a1c1-4ce5-a838-1a5e80952f07",
      Name: "Non-working residency visa (non-lucrative visa)",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
  ];
  var missionDataDza = [
    {
      Id: "bc733646-1ee1-4e12-857e-95ad0c3acee7",
      Name: "Test",
      Code: "TEST",
    },
    {
      Id: "7b831dab-5bed-4f9e-9e13-a301dfce2d77",
      Name: "Consulate - Oran",
      Code: "CONSULATE_ORAN",
    },
    {
      Id: "ec336bcf-29fe-4d76-90f1-a7ae2d74d78b",
      Name: "Consulate - Algiers",
      Code: "CONSULATE_ALGIERS",
    },
  ];

  var locationDataChn = [
    {
      Id: "4385a0c3-0332-430d-a8aa-1e45a6affd9a",
      Name: "Guangzhou",
      Code: "GUANGZHOU",
    },
    {
      Id: "8d780684-1524-4bda-b138-7c71a8591944",
      Name: "Beijing",
      Code: "BEIJING",
    },
    {
      Id: "6f4eca74-7a15-480a-8401-a58146cc2d97",
      Name: "Wuhan",
      Code: "WUHAN",
    },
    {
      Id: "bb164660-e355-48eb-93fe-df68664caf14",
      Name: "Hangzhou",
      Code: "HANGZHOU",
    },
    {
      Id: "9c400f4a-4458-45b9-b8c0-657c02e54607",
      Name: "Changsha",
      Code: "CHANGSHA",
    },
    {
      Id: "e7f4ae3a-0c02-41ce-a7bb-89527197af61",
      Name: "Kunming",
      Code: "KUNMING",
    },
    {
      Id: "fa974c17-c38a-4481-89bd-15332ee9a57b",
      Name: "Fuzhou",
      Code: "FUZHOU",
    },
    {
      Id: "41f1bbfc-0535-4984-aa20-cd37ee33a6bf",
      Name: "Shanghai",
      Code: "SHANGHAI",
    },
    {
      Id: "06dca747-d1a6-4c05-a4ba-fa3239079e9b",
      Name: "Chengdu",
      Code: "CHENGDU",
    },
    {
      Id: "1e413a56-d561-42e1-b989-4687bee7f661",
      Name: "Chongqing",
      Code: "CHONGQING",
    },
    {
      Id: "fd1919e9-da2a-4cc7-86b1-b8937b8594ca",
      Name: "Xi'an",
      Code: "XIAN",
    },
    {
      Id: "8321d24a-d6bc-433d-a4a8-8652f49bbd5e",
      Name: "Shenyang",
      Code: "SHENYANG",
    },
    {
      Id: "442fb5dd-ddca-4a11-a16d-1110b923f3c1",
      Name: "Nanjing",
      Code: "NANJING",
    },
    {
      Id: "1805e27d-ddd6-4148-af8e-3808927748de",
      Name: "Shenzhen",
      Code: "SHENZHEN",
    },
    {
      Id: "baa2c077-c4ee-4d02-884a-c668035c6ec5",
      Name: "Jinan",
      Code: "JINAN",
    },
  ];
  var AppointmentCategoryIdDataChn = [
    {
      Id: "5c2e8e01-796d-4347-95ae-0c95a9177b26",
      Name: "Normal",
      Code: "CATEGORY_NORMAL",
    },
    {
      Id: "37ba2fe4-4551-4c7d-be6e-5214617295a9",
      Name: "Premium",
      Code: "CATEGORY_PREMIUM",
    },
  ];
  var visaIdDataChn = [
    {
      Id: "3033c6d3-579b-47e1-9602-91368d63025c",
      Code: "NATIONAL_VISA",
      Name: "National Visa",
      VisaTypeCode: "NATIONAL_VISA",
    },
    {
      Id: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
      Code: "SCHENGEN_VISA",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
    },
  ];
  var visasubIdDataChn = [
    {
      Id: "f82b8bd9-4897-475d-9301-a61ebcdb80eb",
      Name: "ADS",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "c8c6fdc1-bfd1-4cc4-b389-9c5d0d503105",
      Name: "afdgdffgfd",
      Value: null,
    },
    {
      Id: "792af44a-73c4-4dd0-8db8-69a0d099cf65",
      Name: "Study",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "c1b7e454-a858-457e-8947-e9719a9fcdd3",
      Name: "RLD",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "981fce9e-dbde-4d37-963b-a5c457f2841f",
      Name: "TRP",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "dbd1c9fc-0603-4975-9a2d-44025dadcc0c",
      Name: "SSU Visa",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "76620842-3c79-4f04-b04f-a89289f8bdba",
      Name: "SLU Visa",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "6a7bbf0d-217c-4bc1-a458-54f60bff4811",
      Name: "Schengen Visa",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "e0f5151b-1c68-48ea-9e37-848fcd78c3d7",
      Name: "RES VISA",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "b3ce2540-ee4b-4a1e-b563-c414145b64e2",
      Name: "TRA Visa",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "7c81ab4b-c984-4213-8115-5a8d945d2160",
      Name: "RFK Visa",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "a042cfc7-ccb3-41fc-86cf-87354a7d3cfb",
      Name: "EXT Visa",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "28480516-2d94-4db8-8b17-bafffd805e59",
      Name: "LEY14 Visa",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "5b9d588f-b80a-499c-8436-111c8aa1349d",
      Name: "Tourism",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "41266da2-08f8-4394-937b-107a9f8172c0",
      Name: "Medical reasons",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "00a75af3-6f0c-4cdf-be85-581769c55301",
      Name: "Visiting family or friends ",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "43617021-72bd-44f0-9e66-f1b59291823e",
      Name: "Transit(for seamen)",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "9be61a46-0a54-4117-af04-a987ce9586c3",
      Name: "TRA Visa",
      Value: null,
    },
    {
      Id: "aa296dfa-a383-4689-b0b8-78d83aa1ebe8",
      Name: "ESC Visa",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "021a6f72-bae0-4506-9f1f-806d805751fa",
      Name: "Cultural reasons",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "72968359-a127-4001-941e-28cf6e12ac73",
      Name: "Study",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "0a925344-0ab4-491c-9fb4-fe95d82753fd",
      Name: "Others",
      Value: "3033c6d3-579b-47e1-9602-91368d63025c",
    },
    {
      Id: "11ad4d94-3694-4011-881a-3f6cd95686bd",
      Name: "Official visit",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "4e9517a7-a04d-4e3b-9e59-8e1b7d3a0253",
      Name: "Business/Professional Training ",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "9f7ff50c-64ed-4a93-a81f-6b4a8dbb1b58",
      Name: "Sports",
      Value: "099a0161-b428-4a10-bb1e-639b7dee4fa0",
    },
    {
      Id: "9c2e25c0-96f1-4196-b407-0552a806016d",
      Name: "RES VISA ",
      Value: null,
    },
    {
      Id: "808d70ef-0cd9-4486-9faf-148b3112baee",
      Name: "National Visa",
      Value: null,
    },
    {
      Id: "c47602f6-666a-4125-a5ba-8d8048a0d991",
      Name: "RFK Visa",
      Value: null,
    },
    {
      Id: "128f433d-2de4-4a0a-98b5-0e3341aafc9f",
      Name: "SLU Visa",
      Value: null,
    },
    {
      Id: "a21766e7-57a1-4dca-9b68-119176aeb9c3",
      Name: "SSU Visa",
      Value: null,
    },
    {
      Id: "45842903-0b3f-42d9-913b-aa0652d5ec4d",
      Name: "EXT Visa",
      Value: null,
    },
    {
      Id: "39447933-d0aa-41c9-8399-e520a15647e0",
      Name: "LEY14 Visa",
      Value: null,
    },
    {
      Id: "7d180277-9253-4a1e-bb3e-452cd2cb8af2",
      Name: "ESC Visa",
      Value: null,
    },
    {
      Id: "ab828ce6-d1b3-46e0-8e91-8ffa27d2b6d7",
      Name: "Schengen Visa",
      Value: null,
    },
  ];
  var missionDataChn = [
    {
      Id: "d133459a-6482-45ed-bd00-5ff32aa8b71b",
      Name: "Consulate - Beijing",
      Code: "CONSULATE_BEIJING",
    },
    {
      Id: "235b19fd-9fce-438f-be0a-18275fd0b64d",
      Name: "Consulate-Shanghai",
      Code: "CONSULATE_SHANGHAI",
    },
    {
      Id: "3ee1ef97-553a-4f8a-89c3-025cfc38e91b",
      Name: "Consulate-Guangzhou",
      Code: "CONSULATE_GUANGZHOU",
    },
  ];

  var locationDataEgy = [
    {
      Id: "60d2df036755e8de168d8db7",
      Name: "Cairo",
      Code: "CAIRO",
    },
    {
      Id: "8d780684-1524-4bda-b138-7c71a8591944",
      Name: "Alexandria",
      Code: "ALEXANDRIA",
    },
  ];
  var AppointmentCategoryIdDataEgy = [
    {
      Id: "5c2e8e01-796d-4347-95ae-0c95a9177b26",
      Name: "Normal",
      Code: "CATEGORY_NORMAL",
    },
    {
      Id: "37ba2fe4-4551-4c7d-be6e-5214617295a9",
      Name: "Premium",
      Code: "CATEGORY_PREMIUM",
    },
    {
      Id: "9b1ae169-39b1-4783-aa12-ffa189dec130",
      Name: "Prime Time",
      Code: "PRIME_TIME",
    },
  ];
  var visaIdDataEgy = [
    {
      Id: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
      Name: "National Visa Cairo",
      VisaTypeCode: "NATIONAL_VISA",
      AppointmentSource: null,
      LocationId: "60d2df036755e8de168d8db7",
    },
    {
      Id: "ac08e478-17f2-4516-914c-4d9198fd8d1e",
      Name: "National Visa Alexandria",
      VisaTypeCode: "NATIONAL_VISA",
      AppointmentSource: null,
      LocationId: "8d780684-1524-4bda-b138-7c71a8591944",
    },
    {
      Id: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Name: "Schengen visa Cairo",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "60d2df036755e8de168d8db7",
    },
    {
      Id: "a805c157-7e8f-4932-89cf-d7ab69e1af96",
      Name: "Schengen visa Alexandria",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "8d780684-1524-4bda-b138-7c71a8591944",
    },
    {
      Id: "097cc0b6-a273-4733-ae6b-9c9f67fafafe",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: "WEB_BLS",
      LocationId: "735c0bbb-6e29-4cc6-8259-39a4c1c9a5d4",
    },
  ];
  var visasubIdDataEgy = [
    {
      Id: "0cd6f50e-4d1b-4b2b-9b1e-17d86be38387",
      Name: "National Visa Cairo",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
      Code: "WEB_BLS",
    },
    {
      Id: "17a5c9d8-20e4-49b9-8093-a1a6389c7023",
      Name: "National Visa Alexandria",
      Value: "ac08e478-17f2-4516-914c-4d9198fd8d1e",
      Code: "WEB_BLS",
    },
    {
      Id: "b563f6e3-58c2-48c4-ab37-a00145bfce7c",
      Name: "Schengen Visa Cairo",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "b563f6e3-58c2-48c4-ab37-a00145bfce7c1",
      Name: "Schengen Visa Alexandria",
      Value: "a805c157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "0cd67ba7-ea37-4df4-b142-c111be673d55",
      Name: "Schengen Visa",
      Value: "097cc0b6-a273-4733-ae6b-9c9f67fafafe",
      Code: "WEB_BLS",
    },
    {
      Id: "14e132e5-2f0a-40e1-833f-d0c862eb1899",
      Name: "Student Visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "4d774535-d05b-46bf-83bd-6b98d6d4fd2f",
      Name: "Researcher visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "e3a2e1b1-378e-4f6e-9adb-eacaec8d8ba8",
      Name: "Internship visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "eeb83923-5c8d-4458-9415-64451348c7dc",
      Name: "Family Reunification Visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "43a911df-f7f7-48f8-8dd8-59c65dce32b8",
      Name: "Residence and Employment Work Visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "aaff0199-6d71-4d97-ad45-908819db7fc3",
      Name: "Residence visa with working permit exemption",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "81ed5eb4-9b81-45b4-8df3-ad090286a619",
      Name: "Self-employed work visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "4757ce76-bc0b-4839-9af4-d9ea54363072",
      Name: "Investor visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "abdf02d9-80ae-4be9-b9f9-5d9e459c76a9",
      Name: "Entrepreneur visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "5205d0b9-0bae-42f2-aaf4-d441cdcdd7bb",
      Name: "Long-term residence visa",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "a2a5a09e-2a43-4d77-9b85-fdbc9920382d",
      Name: "Long-term residence or EU Long-term residence recover",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "dde5a936-4903-4965-b68c-da1383a13a70",
      Name: "Visa for highly qualified workers and for intra-company transfers",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
    {
      Id: "12f0c61f-a1c1-4ce5-a838-1a5e80952f07",
      Name: "Non-working residency visa (non-lucrative visa)",
      Value: "ec08e478-17f2-4516-914c-4d9198fd8d1e",
    },
  ];
  var missionDataEgy = [
    {
      Id: "beae2d19-89a9-46e7-9415-5422adafe619",
      Name: "Consulate - Cairo",
      Code: "CONSULATE_CAIRO",
    },
    {
      Id: "c993f2e4-dc1d-4889-96cb-1d447f2a7067",
      Name: "Consulate - Alexandria",
      Code: "CONSULATE_ALEXANDRIA",
    },
  ];

  var locationDataRussia = [
    {
      Id: "d03cae8d-4f8b-41a0-9c3e-59b131dfb5e9",
      Name: "Yekaterinburg",
      Code: "MOS",
    },
    {
      Id: "10398c04-10c2-40c9-b64a-859af3971e41",
      Name: "Kazan",
      Code: "MOS",
    },
    {
      Id: "24b9aa28-fc7a-4dff-85a1-700902b8e3cf",
      Name: "Rostov-on-Don",
      Code: "MOS",
    },
    {
      Id: "fc196dc2-4644-466f-ad54-1bfe0b69bff0",
      Name: "Novosibirsk",
      Code: "MOS",
    },
    {
      Id: "db730384-4d43-4f13-bf8a-a89531fffcdc",
      Name: "Moscow",
      Code: "MOS",
    },
    {
      Id: "4280dc37-9f21-49fe-8281-0a2e0a83739c",
      Name: "Samara",
      Code: "MOS",
    },
    {
      Id: "89b839fa-3d86-4e4f-aa35-b086e102ba7e",
      Name: "St. Petersburg",
      Code: "STP",
    },
    {
      Id: "9ce2b6a0-4704-436f-966a-9813673e679d",
      Name: "Nizhny Novgorod",
      Code: "MOS",
    },
  ];
  var AppointmentCategoryIdDataRussia = [
    {
      Id: "5c2e8e01-796d-4347-95ae-0c95a9177b26",
      Name: "Normal",
      Code: "CATEGORY_NORMAL",
    },
    {
      Id: "37ba2fe4-4551-4c7d-be6e-5214617295a9",
      Name: "Premium",
      Code: "CATEGORY_PREMIUM",
    },
    {
      Id: "0ec883de-84f4-4474-ae60-572e675873cb",
      Name: "Prime Time",
      Code: "PRIME_TIME",
    },
  ];
  var visaIdDataRussia = [
    {
      Id: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "db730384-4d43-4f13-bf8a-a89531fffcdc",
    },
    {
      Id: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "4280dc37-9f21-49fe-8281-0a2e0a83739c",
    },
    {
      Id: "0942a351-3525-4dfb-836c-ed52f1167822",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "89b839fa-3d86-4e4f-aa35-b086e102ba7e",
    },
    {
      Id: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "d03cae8d-4f8b-41a0-9c3e-59b131dfb5e9",
    },
    {
      Id: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "10398c04-10c2-40c9-b64a-859af3971e41",
    },
    {
      Id: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "fc196dc2-4644-466f-ad54-1bfe0b69bff0",
    },
    {
      Id: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "24b9aa28-fc7a-4dff-85a1-700902b8e3cf",
    },
    {
      Id: "3942343d-f913-41be-870d-5ec125e2eade",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "9ce2b6a0-4704-436f-966a-9813673e679d",
    },
  ];
  var visasubIdDataRussia = [
    {
      Id: "01ef17fe-2ca0-43b7-8ab7-1769420b540b",
      Name: "Business",
      Value: "3942343d-f913-41be-870d-5ec125e2eade",
      Code: "WEB_BLS",
    },
    {
      Id: "40f98a6a-679c-4c95-befe-79e0a34bf25e",
      Name: "Business",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
    {
      Id: "8618d7fe-be5d-4116-a3ef-63243e61fc90",
      Name: "Business",
      Value: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Code: "WEB_BLS",
    },
    {
      Id: "9bc3d10e-dffe-4ff2-80f2-36b2ee14fafe",
      Name: "Business",
      Value: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Code: "WEB_BLS",
    },
    {
      Id: "26488f55-74c6-4599-b484-194c062a58f2",
      Name: "Business",
      Value: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Code: "WEB_BLS",
    },
    {
      Id: "13c4e8e9-7a47-4dd7-9cef-58c22a74d5f7",
      Name: "Business",
      Value: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Code: "WEB_BLS",
    },
    {
      Id: "2a785449-0f5e-47b4-8721-1be9b57fc4d0",
      Name: "Business",
      Value: "0942a351-3525-4dfb-836c-ed52f1167822",
      Code: "WEB_BLS",
    },
    {
      Id: "35773c5b-5b75-4217-867b-17a243ae5f19",
      Name: "Business",
      Value: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "665e99c0-0514-49e6-8817-24e65e07f87d",
      Name: "Cultural Activities",
      Value: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Code: "WEB_BLS",
    },
    {
      Id: "cc2bbad6-4d20-4f0d-b681-38a96642658f",
      Name: "Cultural Activities",
      Value: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "b7b1a313-8e61-4611-905d-146d9e56b3f6",
      Name: "Cultural Activities",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
    {
      Id: "0fa8f0ed-b901-4d16-a589-e69d2fc79555",
      Name: "Cultural Activities",
      Value: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Code: "WEB_BLS",
    },
    {
      Id: "b7a59399-33e8-46a7-b7ae-bd933c0494fa",
      Name: "Cultural Activities",
      Value: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Code: "WEB_BLS",
    },
    {
      Id: "5caa0b18-33c2-4cbd-8d1d-0d27e5a93531",
      Name: "Cultural Activities",
      Value: "0942a351-3525-4dfb-836c-ed52f1167822",
      Code: "WEB_BLS",
    },
    {
      Id: "b10e92a0-2c49-40ca-b5c0-e30276b9cc28",
      Name: "Cultural Activities",
      Value: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Code: "WEB_BLS",
    },
    {
      Id: "8fef51f1-5845-4532-b151-25c1daafb7bb",
      Name: "Cultural Activities",
      Value: "3942343d-f913-41be-870d-5ec125e2eade",
      Code: "WEB_BLS",
    },
    {
      Id: "bd9ce332-d6aa-4850-8e32-9a9621f845d8",
      Name: "Drivers & Carriers",
      Value: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Code: "WEB_BLS",
    },
    {
      Id: "71278f86-e5ff-40af-a2a2-fa19305ec96e",
      Name: "Drivers & Carriers",
      Value: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Code: "WEB_BLS",
    },
    {
      Id: "1dd24c85-4e06-48c3-8572-d8cda72dff98",
      Name: "Drivers & Carriers",
      Value: "0942a351-3525-4dfb-836c-ed52f1167822",
      Code: "WEB_BLS",
    },
    {
      Id: "d044f16c-58c0-4ad4-ad4e-a83221a72ca4",
      Name: "Drivers & Carriers",
      Value: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "0ddcd3de-f5cb-4fb5-8dcb-2b2b85c7a211",
      Name: "Drivers & Carriers",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
    {
      Id: "7ad00abf-1a2c-4e14-b263-2d1757d1da78",
      Name: "Drivers & Carriers",
      Value: "3942343d-f913-41be-870d-5ec125e2eade",
      Code: "WEB_BLS",
    },
    {
      Id: "9a49e78b-4467-4e90-acf0-4bf245f5d588",
      Name: "Drivers & Carriers",
      Value: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Code: "WEB_BLS",
    },
    {
      Id: "fa67dfa8-21d3-468b-b010-c10e4eace224",
      Name: "Drivers & Carriers",
      Value: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Code: "WEB_BLS",
    },
    {
      Id: "4322b5d8-de02-4297-894c-0b97ba4ff340",
      Name: "EU/EEE family member",
      Value: "3942343d-f913-41be-870d-5ec125e2eade",
      Code: "WEB_BLS",
    },
    {
      Id: "d798265c-ae6c-4b36-9579-5be4180f3013",
      Name: "EU/EEE family member",
      Value: "0942a351-3525-4dfb-836c-ed52f1167822",
      Code: "WEB_BLS",
    },
    {
      Id: "3821b3ce-1d07-48e2-96f2-b74ef2fdbf08",
      Name: "EU/EEE family member",
      Value: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Code: "WEB_BLS",
    },
    {
      Id: "f4d462c2-d71f-460a-8bd7-c739fd4f413c",
      Name: "EU/EEE family member",
      Value: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "fb9e7296-55e0-4215-a304-def56cdedcf7",
      Name: "EU/EEE family member",
      Value: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Code: "WEB_BLS",
    },
    {
      Id: "4729e050-1c4b-42ad-b771-66038c38454a",
      Name: "EU/EEE family member",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
    {
      Id: "8e9f16c2-6f2a-407d-9931-a5275345b21e",
      Name: "EU/EEE family member",
      Value: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Code: "WEB_BLS",
    },
    {
      Id: "6142f062-9fb1-48fd-a966-de35f97a1196",
      Name: "EU/EEE family member",
      Value: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Code: "WEB_BLS",
    },
    {
      Id: "c00df47c-7e83-4881-8082-a8bca018abd9",
      Name: "Private Invitation",
      Value: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Code: "WEB_BLS",
    },
    {
      Id: "7218d057-c8ab-4f85-8914-0c86ff031f2d",
      Name: "Private Invitation",
      Value: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Code: "WEB_BLS",
    },
    {
      Id: "61f7e25d-4f50-4bde-8b15-c44952c886f3",
      Name: "Private Invitation",
      Value: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Code: "WEB_BLS",
    },
    {
      Id: "d3f3357c-814f-4684-8b60-f4e40a47ba64",
      Name: "Private Invitation",
      Value: "3942343d-f913-41be-870d-5ec125e2eade",
      Code: "WEB_BLS",
    },
    {
      Id: "84f8aa0e-7d6e-4b71-a2e6-53c50971c008",
      Name: "Private Invitation",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
    {
      Id: "b85e48d3-fc56-474a-9d10-d037796298c3",
      Name: "Private Invitation",
      Value: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Code: "WEB_BLS",
    },
    {
      Id: "e542abbd-19de-4742-bb4a-746a6d558336",
      Name: "Private Invitation",
      Value: "0942a351-3525-4dfb-836c-ed52f1167822",
      Code: "WEB_BLS",
    },
    {
      Id: "bd7984c2-7d35-4bd2-a0d8-12a841a0ddbf",
      Name: "Private Invitation",
      Value: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "a9738218-bb5f-4a46-af13-d40ff04519ff",
      Name: "Property owners",
      Value: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "9da43bd4-54e9-419c-8799-b61f95f50299",
      Name: "Property owners",
      Value: "0942a351-3525-4dfb-836c-ed52f1167822",
      Code: "WEB_BLS",
    },
    {
      Id: "6c9f6fd7-8f26-4c38-9706-1820fa582f8a",
      Name: "Property owners",
      Value: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Code: "WEB_BLS",
    },
    {
      Id: "c6094c6b-1f19-4a10-b2c5-0c465266ccf8",
      Name: "Property owners",
      Value: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Code: "WEB_BLS",
    },
    {
      Id: "b594d11f-6732-46af-9680-4c98e7203544",
      Name: "Property owners",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
    {
      Id: "4592528b-85d5-4822-8cbf-ddf664a57053",
      Name: "Property owners",
      Value: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Code: "WEB_BLS",
    },
    {
      Id: "9c145da2-e0a1-481b-8ab4-44d2ff3d4ec4",
      Name: "Property owners",
      Value: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Code: "WEB_BLS",
    },
    {
      Id: "afc21256-b72d-4990-8964-e7813b0d91b2",
      Name: "Property owners",
      Value: "3942343d-f913-41be-870d-5ec125e2eade",
      Code: "WEB_BLS",
    },
    {
      Id: "32f39966-b583-4243-a3b7-fea62c04a3e8",
      Name: "Sailors",
      Value: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "d730050f-63fe-4617-afcf-1c8e82fad793",
      Name: "Sailors",
      Value: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Code: "WEB_BLS",
    },
    {
      Id: "79f38b57-547e-46b6-abdb-97e58ba153ca",
      Name: "Sailors",
      Value: "0942a351-3525-4dfb-836c-ed52f1167822",
      Code: "WEB_BLS",
    },
    {
      Id: "3c115cb4-8b12-47ca-8c86-1a3a20caf31c",
      Name: "Sailors",
      Value: "3942343d-f913-41be-870d-5ec125e2eade",
      Code: "WEB_BLS",
    },
    {
      Id: "5ec3c4b9-0328-4d90-b702-88f2de50f925",
      Name: "Sailors",
      Value: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Code: "WEB_BLS",
    },
    {
      Id: "6b0c423e-6802-4c71-847e-52bb292bacfc",
      Name: "Sailors",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
    {
      Id: "92aa7c03-79c7-422b-9df8-b166f71536e4",
      Name: "Sailors",
      Value: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Code: "WEB_BLS",
    },
    {
      Id: "3f087dda-86cf-428d-9529-30cd81b2bdba",
      Name: "Sailors",
      Value: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Code: "WEB_BLS",
    },
    {
      Id: "8089d9b6-adad-4697-bc4b-2acf34c625ca",
      Name: "Schengen Visa",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
    {
      Id: "5830c4c2-ed91-41f2-8b83-2e78d05118bd",
      Name: "Studies of less than 90 days",
      Value: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Code: "WEB_BLS",
    },
    {
      Id: "a58598ec-57cf-4492-b3b1-d8b05ee525f6",
      Name: "Studies of less than 90 days",
      Value: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Code: "WEB_BLS",
    },
    {
      Id: "e632b479-505b-4650-94b1-5c879cb84d13",
      Name: "Studies of less than 90 days",
      Value: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Code: "WEB_BLS",
    },
    {
      Id: "69d17956-c087-41ad-8ced-12e089458b73",
      Name: "Studies of less than 90 days",
      Value: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "d3c1c1d2-9870-4b5e-b618-99178c37ba8d",
      Name: "Studies of less than 90 days",
      Value: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Code: "WEB_BLS",
    },
    {
      Id: "12893f56-784a-4a3e-9eff-139f3487ee00",
      Name: "Studies of less than 90 days",
      Value: "0942a351-3525-4dfb-836c-ed52f1167822",
      Code: "WEB_BLS",
    },
    {
      Id: "c47f8bec-e9fb-4441-b9f8-8809f3f6a34d",
      Name: "Studies of less than 90 days",
      Value: "3942343d-f913-41be-870d-5ec125e2eade",
      Code: "WEB_BLS",
    },
    {
      Id: "688ca252-a2a3-4d82-8d40-c2d00e5d79f8",
      Name: "Studies of less than 90 days",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
    {
      Id: "31276a58-dcd0-41ff-9df8-5a76054eb4dc",
      Name: "Tourism",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
    {
      Id: "3f15af66-3bba-4ca8-b03c-3eb546305445",
      Name: "Tourism",
      Value: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "8d732587-e84e-4456-92c6-ed40725e77df",
      Name: "Tourism",
      Value: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Code: "WEB_BLS",
    },
    {
      Id: "c94afbed-629e-4744-8cfd-6bdb98e37c5e",
      Name: "Tourism",
      Value: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Code: "WEB_BLS",
    },
    {
      Id: "366f5230-e85f-4cf4-a747-4e2970f89037",
      Name: "Tourism",
      Value: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Code: "WEB_BLS",
    },
    {
      Id: "4bca75a9-ec25-43db-a57f-05ba24d84ba5",
      Name: "Tourism",
      Value: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Code: "WEB_BLS",
    },
    {
      Id: "f8a1796b-80db-4922-a717-146657243e8e",
      Name: "Tourism",
      Value: "3942343d-f913-41be-870d-5ec125e2eade",
      Code: "WEB_BLS",
    },
    {
      Id: "207578b7-e705-4220-9379-54cb0947f5f0",
      Name: "Tourism",
      Value: "0942a351-3525-4dfb-836c-ed52f1167822",
      Code: "WEB_BLS",
    },
    {
      Id: "fca310c8-8ac7-45a2-8835-c6c76ed1eb5a",
      Name: "Transit",
      Value: "f4fdb418-3393-4772-bfb6-63e61c5484de",
      Code: "WEB_BLS",
    },
    {
      Id: "d785ef96-bfbc-42ac-8150-0c866aac2b58",
      Name: "Transit",
      Value: "0942a351-3525-4dfb-836c-ed52f1167822",
      Code: "WEB_BLS",
    },
    {
      Id: "1e0dc870-326f-4024-abdf-aeb666699e7f",
      Name: "Transit",
      Value: "94560630-30c4-4e76-bfb5-6c11f2d98fb4",
      Code: "WEB_BLS",
    },
    {
      Id: "23e05fff-7846-401c-8f3a-a71dfeb0c98c",
      Name: "Transit",
      Value: "3942343d-f913-41be-870d-5ec125e2eade",
      Code: "WEB_BLS",
    },
    {
      Id: "905a6af5-0f67-4b1d-909d-4f02b5740ba6",
      Name: "Transit",
      Value: "12388157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "c9d685f0-9fc4-4fce-bce6-88d99e1aa597",
      Name: "Transit",
      Value: "a71f5cee-d480-4ac8-b781-2d6a834198b1",
      Code: "WEB_BLS",
    },
    {
      Id: "99459edd-e949-43e6-ab32-ba94ac0aa486",
      Name: "Transit",
      Value: "77ead1cd-44e7-41b8-a2a7-906eae43295d",
      Code: "WEB_BLS",
    },
    {
      Id: "705dc50d-2ec0-4830-b6f2-4ec75ff82a7b",
      Name: "Transit",
      Value: "f85f8028-05e4-4b20-9095-9e768dd71b6e",
      Code: "WEB_BLS",
    },
  ];
  var missionDataRussia = [];

  var locationDataUk = [
    {
      Id: "0566245a-7ba1-4b5a-b03b-3dd33e051f46",
      Name: "Edinburgh",
      Code: "EDI",
    },
    {
      Id: "8d780684-1524-4bda-b138-7c71a8591944",
      Name: "Manchester",
      Code: "MAN",
    },
    {
      Id: "60d2df036755e8de168d8db7",
      Name: "London",
      Code: "LON",
    },
  ];
  var AppointmentCategoryIdDataUk = [
    {
      Id: "5c2e8e01-796d-4347-95ae-0c95a9177b26",
      Name: "Normal",
      Code: "CATEGORY_NORMAL",
    },
    {
      Id: "37ba2fe4-4551-4c7d-be6e-5214617295a9",
      Name: "Premium",
      Code: "CATEGORY_PREMIUM",
    },
    {
      Id: "49e35a1a-d03c-463c-af72-e948e3373b7b",
      Name: "Doorstep Service",
      Code: "DOORSTEP_SERVICE",
    },
  ];
  var visaIdDataUk = [
    {
      Id: "c805c157-7e8f-4932-89cf-d7ab69e1af961",
      Name: "Short Term Visa(Maximum stay of 90 days) Manchester",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "8d780684-1524-4bda-b138-7c71a8591944",
    },
    {
      Id: "c805c157-7e8f-4932-89cf-d7ab69e1af962",
      Name: "Short Term Visa(Maximum stay of 90 days) Edinburgh",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "0566245a-7ba1-4b5a-b03b-3dd33e051f46",
    },
    {
      Id: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Name: "Short Term Visa(Maximum stay of 90 days)",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "60d2df036755e8de168d8db7",
    },
    {
      Id: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Name: "National Visa / Long Term Visa Manchester",
      VisaTypeCode: "NATIONAL_VISA",
      AppointmentSource: null,
      LocationId: "8d780684-1524-4bda-b138-7c71a8591944",
    },
    {
      Id: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Name: "National Visa / Long Term Visa Edinburgh",
      VisaTypeCode: "NATIONAL_VISA",
      AppointmentSource: null,
      LocationId: "0566245a-7ba1-4b5a-b03b-3dd33e051f46",
    },
    {
      Id: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Name: "National Visa / Long Term Visa",
      VisaTypeCode: "NATIONAL_VISA",
      AppointmentSource: null,
      LocationId: "60d2df036755e8de168d8db7",
    },
  ];
  var visasubIdDataUk = [
    {
      Id: "cfe9c066-0ab0-4acf-af34-aeea70f24d962",
      Name: "Business Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af962",
      Code: "WEB_BLS",
    },
    {
      Id: "cfe9c066-0ab0-4acf-af34-aeea70f24d961",
      Name: "Business Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af961",
      Code: "WEB_BLS",
    },
    {
      Id: "cfe9c066-0ab0-4acf-af34-aeea70f24d96",
      Name: "Business Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "3e15dfaf-3951-4114-b8ed-aaea3f1638cf",
      Name: "DEPENDANTS OF RFK",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "65e2e59b-aba2-4657-8a41-4e7520d29cca",
      Name: "DEPENDANTS OF RFK",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "a201ed5a-a6ce-447c-9f17-f5798254a02d",
      Name: "DEPENDANTS OF RFK",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "e2e67d45-007d-414a-bd0f-06eff63733912",
      Name: "Digital Nomad Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "e2e67d45-007d-414a-bd0f-06eff63733911",
      Name: "Digital Nomad Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "e2e67d45-007d-414a-bd0f-06eff6373391",
      Name: "Digital Nomad Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "1645b588-1451-4a79-87f6-9ea349b056731",
      Name: "Entrepreneur visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "1645b588-1451-4a79-87f6-9ea349b05673",
      Name: "Entrepreneur visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "1645b588-1451-4a79-87f6-9ea349b056732",
      Name: "Entrepreneur visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "131d171a-db2f-42f9-bf85-e6966346c5ab1",
      Name: "EU/EEA Spouse and Family Member",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af961",
      Code: "WEB_BLS",
    },
    {
      Id: "131d171a-db2f-42f9-bf85-e6966346c5ab",
      Name: "EU/EEA Spouse and Family Member",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "131d171a-db2f-42f9-bf85-e6966346c5ab2",
      Name: "EU/EEA Spouse and Family Member",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af962",
      Code: "WEB_BLS",
    },
    {
      Id: "a981c7ca-5bf2-475f-9173-939b688c5ce4",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER ESA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "9304b4d1-48e7-4d7b-9c17-55fa97a69b41",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER ESA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "34df9c25-d741-4095-b7fd-9ec1609213ff",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER ESA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "cc0cfde9-6258-4f18-8073-1d5837f4939b",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER ESA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "7ec6624a-1dc6-49f9-9eb1-49f5878d6282",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER ESA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "edf7d571-ca45-4f66-a710-0dfb6f1e8a87",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER ESA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "e8c15b77-acd6-4e76-91a0-0be9af819262",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER ESA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "5b1215b8-6954-4444-830b-f0e6e6140652",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER ESA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "ddb79028-3052-4ff7-8651-6d15666e1d80",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER ESA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "6bc00da8-bd76-4d0a-96cb-ac3ac7a534de",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER RSA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "832573c7-cdda-4419-8f6f-bcc0fbf1f7d0",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER RSA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "3b157e78-b8f4-4f4c-a73c-0b3e94bd8a02",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER RSA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "37ea17d0-c82d-4e8c-9c6e-081825a13528",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER RSA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "ce64ed2f-a21c-4f3b-b86b-57ee9a1dd6d4",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER RSA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "bf03e721-39e5-434e-9a88-8c7605d3196c",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER RSA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "f5b1f49e-18c3-4d5a-b98c-48c857c546cf",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER RSA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "ef2c5e61-23df-4973-bf3a-7c4a6aa0d2c6",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER RSA",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "1e37a4a6-6904-4ae3-b684-e2e71995195f",
      Name: "FAMILY MEMBER OF AUDIOVISUAL SECTOR WORKER RSA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "bc7b5fa9-a612-4149-a84a-ace27ac4cc25",
      Name: "FAMILY MEMBER OF DIGITAL NOMAD",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "d24e33f6-0f50-4a90-b93c-f9a2d2b1eed6",
      Name: "FAMILY MEMBER OF DIGITAL NOMAD",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "0fd126db-97b7-4e4b-94fa-7b459e2f6c15",
      Name: "FAMILY MEMBER OF DIGITAL NOMAD",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "e6d49050-2bd2-4313-964c-2ccfc014e5b2",
      Name: "FAMILY MEMBER OF DIGITAL NOMAD",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "cbc8a66c-2cbc-42c9-a6e6-89f32b3860f0",
      Name: "FAMILY MEMBER OF DIGITAL NOMAD",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "53f7ac4e-200a-44f3-931f-9b3790fdcdcb",
      Name: "FAMILY MEMBER OF DIGITAL NOMAD",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "a31142bd-96f2-4771-b266-6fb881bb04a4",
      Name: "FAMILY MEMBER OF DIGITAL NOMAD",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "d8d6543e-c5ce-4685-a884-7dc27d228b2f",
      Name: "FAMILY MEMBER OF DIGITAL NOMAD",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "69b059fa-97df-4f9c-9823-906f314370b1",
      Name: "FAMILY MEMBER OF DIGITAL NOMAD",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "2ee8fc4b-230d-4c7d-b154-e91609f68dc5",
      Name: "FAMILY MEMBER OF INTRA-CORPORATE TRANSFERRED WORKER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "64706f5c-7a5e-474c-a847-6d0059447f45",
      Name: "FAMILY MEMBER OF INTRA-CORPORATE TRANSFERRED WORKER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "4ab177fe-0a0f-4220-a33f-59c75837f65b",
      Name: "FAMILY MEMBER OF INTRA-CORPORATE TRANSFERRED WORKER",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "39e17f34-b2e0-43a1-8df7-ce01656d3e99",
      Name: "FAMILY MEMBER OF INTRA-CORPORATE TRANSFERRED WORKER",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "e712fb04-2b1a-464b-be30-a8fbcfb827b8",
      Name: "FAMILY MEMBER OF INTRA-CORPORATE TRANSFERRED WORKER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "0c226e07-1790-47fa-8720-7409b36a1f54",
      Name: "FAMILY MEMBER OF INTRA-CORPORATE TRANSFERRED WORKER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "0c5d8f26-f115-4dcc-bc9e-9ae3c5360dff",
      Name: "FAMILY MEMBER OF INTRA-CORPORATE TRANSFERRED WORKER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "a5ba8b52-7065-4620-815f-e9fc5022d74f",
      Name: "FAMILY MEMBER OF INTRA-CORPORATE TRANSFERRED WORKER",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "d4733757-d0f0-42dc-9e6b-8171ba2d3633",
      Name: "FAMILY MEMBER OF INTRA-CORPORATE TRANSFERRED WORKER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "ce2f56b5-3219-46fd-b32e-d9c5db6ffff9",
      Name: "FAMILY MEMBER OF INVESTOR OR OF ENTREPRENEUR",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "36a7afd3-0cb0-4ed2-afdf-9490b8a9a8ff",
      Name: "FAMILY MEMBER OF INVESTOR OR OF ENTREPRENEUR",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "57ca385c-530d-4e07-9d00-17fcea752c6e",
      Name: "FAMILY MEMBER OF INVESTOR OR OF ENTREPRENEUR",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "7883ca97-2238-4a38-95b3-432406978cd3",
      Name: "FAMILY MEMBER OF RESEARCHER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "733a3941-8059-4ab5-b91c-4cd5bab23165",
      Name: "FAMILY MEMBER OF RESEARCHER",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "cfe4a327-f98f-4061-91e8-dbf8224f3a89",
      Name: "FAMILY MEMBER OF RESEARCHER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "726b9afa-d60a-41d7-bb18-359a50dfd8d1",
      Name: "FAMILY MEMBER OF RESEARCHER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "8d8f305e-2504-4d6e-8c5f-1ee62f6e58ae",
      Name: "FAMILY MEMBER OF RESEARCHER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "0164b11f-f47e-400a-8380-28b03155a504",
      Name: "FAMILY MEMBER OF RESEARCHER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "8dab7b83-9c6c-43ba-b1af-5d1cbaec1561",
      Name: "FAMILY MEMBER OF RESEARCHER",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "62c88f30-2a67-4096-b11d-d4abdc830200",
      Name: "FAMILY MEMBER OF RESEARCHER",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "cb398621-f13b-4ce5-afda-5fa11e7833be",
      Name: "FAMILY MEMBER OF RESEARCHER",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "91641a2a-0d97-4f92-b690-b736ee1421c0",
      Name: "FAMILY MEMBERS OF HIGHLY QUALIFIED PROFESSIONAL",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "01d70a70-5048-441a-919a-3fb93830844b",
      Name: "FAMILY MEMBERS OF HIGHLY QUALIFIED PROFESSIONAL",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "4f401443-dd7e-47b9-b887-48dca077540d",
      Name: "FAMILY MEMBERS OF HIGHLY QUALIFIED PROFESSIONAL",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "193ee69e-bd77-4315-b103-a625a4068ed0",
      Name: "FAMILY MEMBERS OF HIGHLY QUALIFIED PROFESSIONAL",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "686257ca-a6a4-453b-a792-4f2948e75c58",
      Name: "FAMILY MEMBERS OF HIGHLY QUALIFIED PROFESSIONAL",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "82c09baf-a558-4bde-a6bc-e860d56e2411",
      Name: "FAMILY MEMBERS OF HIGHLY QUALIFIED PROFESSIONAL",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "65834cf3-d06c-402d-bcfe-e36f8dde9378",
      Name: "FAMILY MEMBERS OF HIGHLY QUALIFIED PROFESSIONAL",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "b94044d9-a6ec-435d-b31c-32052d1b1336",
      Name: "FAMILY MEMBERS OF HIGHLY QUALIFIED PROFESSIONAL",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "e960fe8e-a248-422d-9013-21e94724ddd2",
      Name: "FAMILY MEMBERS OF HIGHLY QUALIFIED PROFESSIONAL",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "2758a47b-eced-4c6c-b356-0bceb1022f78",
      Name: "FIX-TERM CONTRACT WORK VISA - WITH AUTHORIZATION",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "5b37935e-6f4e-48fe-82e7-82487e7bc971",
      Name: "FIX-TERM CONTRACT WORK VISA - WITH AUTHORIZATION",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "c336ab6a-31fc-4e64-96ac-380bf776effc",
      Name: "FIX-TERM CONTRACT WORK VISA - WITH AUTHORIZATION",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "348fac0c-af49-4959-9f48-738876a0a929",
      Name: "FIX-TERM CONTRACT WORK VISA - WITH AUTHORIZATION",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "b57e1127-ea17-4a41-9215-730fc868e9a7",
      Name: "FIX-TERM CONTRACT WORK VISA - WITH AUTHORIZATION",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "03c335ee-ca39-482e-a265-18b71b98c869",
      Name: "FIX-TERM CONTRACT WORK VISA - WITH AUTHORIZATION",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "59795d84-120f-487d-bc3f-da2ea8f8ac72",
      Name: "FIX-TERM CONTRACT WORK VISA WITH AUTHORIZATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "125d5cea-d969-4861-a4f3-01e331568fc0",
      Name: "FIX-TERM CONTRACT WORK VISA WITH AUTHORIZATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "e6b34ec4-4200-40ff-ade9-aa5791792ce1",
      Name: "FIX-TERM CONTRACT WORK VISA WITH AUTHORIZATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "de724964-57a0-4bf6-a14a-9ee8b575904f2",
      Name: "General scheme for the family reunification visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "de724964-57a0-4bf6-a14a-9ee8b575904f",
      Name: "General scheme for the family reunification visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "de724964-57a0-4bf6-a14a-9ee8b575904f1",
      Name: "General scheme for the family reunification visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "2978310e-4a7e-4e08-9725-3ca1bab4a5822",
      Name: "House Maid/Au Pair",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af962",
      Code: "WEB_BLS",
    },
    {
      Id: "2978310e-4a7e-4e08-9725-3ca1bab4a5821",
      Name: "House Maid/Au Pair",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af961",
      Code: "WEB_BLS",
    },
    {
      Id: "2978310e-4a7e-4e08-9725-3ca1bab4a582",
      Name: "House Maid/Au Pair",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "a1019f6a-709f-4855-a1bc-c0622759db6e",
      Name: "Internship Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "a1019f6a-709f-4855-a1bc-c0622759db6e2",
      Name: "Internship Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "a1019f6a-709f-4855-a1bc-c0622759db6e1",
      Name: "Internship Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "d77cc044-935d-453c-bb49-870f9801fbec1",
      Name: "Investor Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "d77cc044-935d-453c-bb49-870f9801fbec2",
      Name: "Investor Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "d77cc044-935d-453c-bb49-870f9801fbec",
      Name: "Investor Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "c426d360-3461-4d75-afa3-19054bfe2cbc",
      Name: "Investor Visa - Family Member",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "b1c85b83-674a-4efd-82f7-b91c47fbb843",
      Name: "Investor Visa - Family Member",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "0f54d4a2-8556-4efb-8cf0-f94d66b63e69",
      Name: "Investor Visa - Family Member",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "89eb572f-0960-4755-a938-52e339ff636e",
      Name: "LONG-TERM RESIDENCE RECOVERY VISAS",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "935b0d57-fd12-4404-ab34-dc3af46759df",
      Name: "LONG-TERM RESIDENCE RECOVERY VISAS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "e78247dd-0599-4009-8417-b8e3ab1537db",
      Name: "LONG-TERM RESIDENCE RECOVERY VISAS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "99901631-8839-4e76-a255-7f6dc45eea95",
      Name: "LONG-TERM RESIDENCE RECOVERY VISAS",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "1550ad60-e66e-4b14-8b04-f02a69a8800c",
      Name: "LONG-TERM RESIDENCE RECOVERY VISAS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "11b566b3-106c-4ebe-97ad-c1f88053117b",
      Name: "LONG-TERM RESIDENCE RECOVERY VISAS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "a62ce591-54ea-42a2-a83e-8ab5be36997a",
      Name: "LONG-TERM RESIDENCE RECOVERY VISAS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "d8c81aeb-8585-4e1f-a704-f219f3689ef7",
      Name: "LONG-TERM RESIDENCE RECOVERY VISAS",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "5b1aafc2-a62d-474d-88d4-48f91903cded",
      Name: "LONG-TERM RESIDENCE RECOVERY VISAS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "9e0c0816-a1af-4645-aa81-7ab9de5fafd6",
      Name: "NLV dependent",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "96e931af-f94a-4ab2-a542-80be82a0964d",
      Name: "NLV dependent",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "744b2e9b-79dc-40ec-870d-b136dcecb645",
      Name: "NLV dependent",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "4942a1b3-f8bd-412f-a30c-438ce83ccbc8",
      Name: "Non-working residency visa (non-lucrative visa)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "4942a1b3-f8bd-412f-a30c-438ce83ccbc81",
      Name: "Non-working residency visa (non-lucrative visa)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "4942a1b3-f8bd-412f-a30c-438ce83ccbc82",
      Name: "Non-working residency visa (non-lucrative visa)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "04f73afa-d061-466e-8fa2-34b5e97dfdb3",
      Name: "PHD STUDENT-RESEARCH",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "9f4ed4ad-08d1-4a88-9e2b-0a60d4bbf0ae",
      Name: "PHD STUDENT-RESEARCH",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "567e1f6c-2d3b-4a6d-a264-e1424c24e539",
      Name: "PHD STUDENT-RESEARCH",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "2a7435c9-a795-4c80-969a-e0afcc95cf091",
      Name: "Researcher Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "2a7435c9-a795-4c80-969a-e0afcc95cf092",
      Name: "Researcher Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "2a7435c9-a795-4c80-969a-e0afcc95cf09",
      Name: "Researcher Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "520f76d3-966f-4140-b88c-ab2762776171",
      Name: "Residence and employment work visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "520f76d3-966f-4140-b88c-ab27627761712",
      Name: "Residence and employment work visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "520f76d3-966f-4140-b88c-ab27627761711",
      Name: "Residence and employment work visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "61053d36-4a00-40af-9a3a-c5cf8184cbbb",
      Name: "Residence visa with working permit exemption (more than 90 days)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "61053d36-4a00-40af-9a3a-c5cf8184cbbb1",
      Name: "Residence visa with working permit exemption (more than 90 days)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "61053d36-4a00-40af-9a3a-c5cf8184cbbb2",
      Name: "Residence visa with working permit exemption (more than 90 days)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "a13e935a-1cfd-40b2-9dd2-fb912192ad72",
      Name: "Self-employed work visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "a13e935a-1cfd-40b2-9dd2-fb912192ad721",
      Name: "Self-employed work visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "a13e935a-1cfd-40b2-9dd2-fb912192ad722",
      Name: "Self-employed work visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "b7a9e5e0-ca3c-48b1-aa32-5f41c095ab8c2",
      Name: "Student Visa",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "7128ad69-236a-4594-9ca9-4bd80575ccd6",
      Name: "STUDENT'S FAMILY MEMBERS",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "b4b0e940-23b9-4745-9e17-793c71d4b1fa",
      Name: "STUDENT'S FAMILY MEMBERS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "559068db-bfb8-458d-8b0b-791c83195f50",
      Name: "STUDENT'S FAMILY MEMBERS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "aaec0b15-78bf-483d-9c7c-554393286ed7",
      Name: "STUDENT'S FAMILY MEMBERS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "3ddbefbe-0076-4e1d-a974-673226ff843b",
      Name: "STUDENT'S FAMILY MEMBERS",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "bc552825-d995-4a17-b29f-a4c5ef5287e9",
      Name: "STUDENT'S FAMILY MEMBERS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "4fe47e3b-1331-4799-9219-2e7e4f2122fd",
      Name: "STUDENT'S FAMILY MEMBERS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "6cb818e2-b5d8-43be-a187-c32570efde0a",
      Name: "STUDENT'S FAMILY MEMBERS",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "c8e6499a-8954-45dd-a1aa-c67dae9d180f",
      Name: "STUDENT'S FAMILY MEMBERS",
      Value: null,
      Code: "WEB_BLS",
    },
    {
      Id: "3acdb8bc-960d-41cb-a62d-c9cb4415c326",
      Name: "Student's family visa less than 180 days",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "1ce5b913-4298-49ca-a9ca-f47e70613c5e",
      Name: "Student's family visa more than 180 days",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "2fe37dc8-d3b8-4d68-a6e7-772c3250f69b",
      Name: "STUDIES MORE THAN 90 DAYS AND LESS THAN 180 DAYS",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "c7653206-a3bc-4b35-8113-4f39e7da754f2",
      Name: "Study Visa LESS than 180 days",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "c7653206-a3bc-4b35-8113-4f39e7da754f1",
      Name: "Study Visa LESS than 180 days",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "c7653206-a3bc-4b35-8113-4f39e7da754f",
      Name: "Study Visa LESS than 180 days",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "549728fb-777e-42f1-a268-1c691454c3c52",
      Name: "Study Visa MORE than 180 days",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "549728fb-777e-42f1-a268-1c691454c3c51",
      Name: "Study Visa MORE than 180 days",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "549728fb-777e-42f1-a268-1c691454c3c5",
      Name: "Study Visa MORE than 180 days",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "b62e2e98-1034-4c85-847b-ee0ebf3398221",
      Name: "Tourist Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af961",
      Code: "WEB_BLS",
    },
    {
      Id: "b62e2e98-1034-4c85-847b-ee0ebf3398222",
      Name: "Tourist Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af962",
      Code: "WEB_BLS",
    },
    {
      Id: "b62e2e98-1034-4c85-847b-ee0ebf339822",
      Name: "Tourist Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "0a761d08-037d-4a71-9091-6940b0da44ae",
      Name: "Transit Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af96",
      Code: "WEB_BLS",
    },
    {
      Id: "0a761d08-037d-4a71-9091-6940b0da44ae1",
      Name: "Transit Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af961",
      Code: "WEB_BLS",
    },
    {
      Id: "0a761d08-037d-4a71-9091-6940b0da44ae2",
      Name: "Transit Visa",
      Value: "c805c157-7e8f-4932-89cf-d7ab69e1af962",
      Code: "WEB_BLS",
    },
    {
      Id: "c7653206-a3bc-4b35-8113-4f39e7da754h2",
      Name: "Visa for highly qualified workers ",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "c7653206-a3bc-4b35-8113-4f39e7da754h1",
      Name: "Visa for highly qualified workers ",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "c7653206-a3bc-4b35-8113-4f39e7da754h",
      Name: "Visa for highly qualified workers ",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "11967553-b4a8-448e-a8ea-19ef12dea3fd",
      Name: "WORK VISA -  SELF EMPLOYMENT-WITH AUTHORIZATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "c5fad059-7e74-44c2-b556-d6936351072e",
      Name: "WORK VISA -  SELF EMPLOYMENT-WITH AUTHORIZATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "57905976-0f19-4402-bc72-948c83f62bce",
      Name: "WORK VISA -  SELF EMPLOYMENT-WITH AUTHORIZATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "5adf2f49-4a02-485c-91c4-0217ee873b66",
      Name: "WORK VISA-EMPLOYMENT WORK-WITH AUTHORIZATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "f20a6546-8555-4c7b-9f6b-af51fa37d4d9",
      Name: "WORK VISA-EMPLOYMENT WORK-WITH AUTHORIZATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "19c9c57e-c3ac-436a-aab2-a655e0cb39f3",
      Name: "WORK VISA-EMPLOYMENT WORK-WITH AUTHORIZATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "7b6af520-9b60-4dfe-8d49-4184814d725f",
      Name: "WORK VISAS UNDER WORKING PERMIT EXEMPTION REGULATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "922dec4a-6afa-406d-8a43-9fa52ea9d809",
      Name: "WORK VISAS UNDER WORKING PERMIT EXEMPTION REGULATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "82b71b48-0f1f-4b90-bc49-49c442ec521b",
      Name: "WORK VISAS UNDER WORKING PERMIT EXEMPTION REGULATION",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "c99090dc-81df-4c41-b09d-943433035b7e",
      Name: "WORK VISAS UNDER WORKING PERMIT EXEMPTION REGULATION (UNDER   90 DAYS)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "9fce563a-d7e4-45f7-843f-c32dac65f70e",
      Name: "WORK VISAS UNDER WORKING PERMIT EXEMPTION REGULATION (UNDER   90 DAYS)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "d68832c0-5480-4960-bce2-4abe77b70fd4",
      Name: "WORK VISAS UNDER WORKING PERMIT EXEMPTION REGULATION (UNDER   90 DAYS)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "2caac8d1-9b5f-44b5-b25e-305bc3abfb2f",
      Name: "WORK VISAS UNDER WORKING PERMIT EXEMPTION REGULATION (UNDER 180 DAYS)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "38bd0b5a-401c-4150-a4e7-08efa32b3e7c",
      Name: "WORK VISAS UNDER WORKING PERMIT EXEMPTION REGULATION (UNDER 180 DAYS)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "254ea389-b902-44b3-8d6c-8b5bb92ff465",
      Name: "WORK VISAS UNDER WORKING PERMIT EXEMPTION REGULATION (UNDER 180 DAYS)",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "877e16fb-8f71-412e-a294-a5c9b768243d",
      Name: "WORKING HOLIDAY",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "8f7a24aa-62f6-4fab-9ad2-4ee044241758",
      Name: "WORKING HOLIDAY",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "9c7c8e15-7623-4eb6-a8d8-b77825e2a86b",
      Name: "WORKING HOLIDAY",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "74fff7a8-fd70-4331-8cd1-dcae2579f990",
      Name: "Working visa for Professionals in the audiovisual sector (2 check lists) less than 180 ESA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "74fff7a8-fd70-4331-8cd1-dcae2579f9902",
      Name: "Working visa for Professionals in the audiovisual sector (2 check lists) less than 180 ESA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "74fff7a8-fd70-4331-8cd1-dcae2579f9901",
      Name: "Working visa for Professionals in the audiovisual sector (2 check lists) less than 180 ESA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
    {
      Id: "43114e5d-fd91-45b5-b5e0-9147bcf135c32",
      Name: "Working visa for Professionals in the audiovisual sector (2 check lists) More than 180 ESA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df2",
      Code: "WEB_BLS",
    },
    {
      Id: "43114e5d-fd91-45b5-b5e0-9147bcf135c3",
      Name: "Working visa for Professionals in the audiovisual sector (2 check lists) More than 180 ESA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df",
      Code: "WEB_BLS",
    },
    {
      Id: "43114e5d-fd91-45b5-b5e0-9147bcf135c31",
      Name: "Working visa for Professionals in the audiovisual sector (2 check lists) More than 180 ESA",
      Value: "fb33a698-a3bd-4b02-8ef7-b589775187df1",
      Code: "WEB_BLS",
    },
  ];
  var missionDataUk = [];

  var jurisdictionDataUk = [
    {
      Id: "81ba77db-37c6-4760-a4ba-59c38bc024ed",
      Name: " GREATER MANCHESTER",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "647122d0-50c0-420c-92bb-b4485cbdc57f",
      Name: " ISLE OF WIGHT",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "26342c41-9242-4045-bca8-1336b0b564a2",
      Name: "Bedfordshire",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "1bd7eaf4-3270-4b2c-a998-e86d81f83d0d",
      Name: "Berkshire",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "b5fa1315-6f28-433c-b26a-0aadbda4f54a",
      Name: "Bermudas",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "ead62aec-e2a6-4cb3-84e0-daf69adab123",
      Name: "Birmingham",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "e130409e-1f48-43b5-8186-01ed120aa543",
      Name: "Bristol",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "d1784d83-ad78-49ef-b7a0-5d4266a781dc",
      Name: "Buckinghamshire",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "294d0831-388b-493a-ac15-b17e154e95ff",
      Name: "Cambridgeshire",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "c62aefc2-f084-4178-8433-51629d6892e7",
      Name: "Cayman Islands",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "1459fc7c-0c1e-4f11-93e2-6a94c1bbab27",
      Name: "CHESHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "9d76d1c5-da37-44f3-8356-8805803c6e1e",
      Name: "CLEVELAND",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "2dad04d3-b9ae-4d30-80fd-e3a7afd98b07",
      Name: "Cornwall",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "c4665dbd-5c49-47e0-9661-8a92043e91b0",
      Name: "CUMBRIA",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "c04919f5-f2bc-4959-ad39-64a09969c7d8",
      Name: "DARLINGTON",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "e9ea0537-ee0e-47d0-a264-1aa64f8eb056",
      Name: "DERBYSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "90dec1a4-1ff4-4d71-b646-d763539234b8",
      Name: "Devon",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "12be21af-a5ad-451d-b80d-83ca16924f86",
      Name: "Dorset",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "200ef3ef-530a-42da-ad32-6afefd1d97a8",
      Name: "DURHAM",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "3b022377-1f4f-410d-b645-0294a92f8b97",
      Name: "EAST RIDING OF YORKSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "43d6e07a-58cf-40fb-90a1-aee01d25b00f",
      Name: "East Sussex",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "d66a8328-93ea-479e-bc32-28228dd2092d",
      Name: "Essex",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "0c4bda8a-afd4-4c7f-9007-e7dd962d9fb4",
      Name: "Falkland ",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "7aabe029-8413-4100-a43f-e63ed874c0fb",
      Name: "Gibraltar",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "4840ad53-b1ab-4264-97d8-b7bf3facb166",
      Name: "Gloucestershire",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "a82136c5-8396-4a93-8d78-23525cc51814",
      Name: "Greater London",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "914586ae-ca44-49e5-b3eb-fda424e67364",
      Name: "Guernsey",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "75ceadb6-b4c3-4658-a2ba-a0b9b8828223",
      Name: "Hampshire",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "20766e5b-5bb1-48a9-a181-8f2584eaa950",
      Name: "HARTLEPOOL",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "28260a90-b578-4414-b2a8-c505ff070f5a",
      Name: "HEREFORDSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "292043eb-f657-498e-b5bb-e282452f3894",
      Name: "HERTFORDSHIRE",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "d7d41b3e-4d04-4cfa-811e-bc9d19049a83",
      Name: "HUMBER",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "ca2a181c-a39a-4076-a2b1-82309151e1a1",
      Name: "ILES OF SCILLY",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "a0dfe154-31b8-42ef-a4f0-08c2e2800d5a",
      Name: "Islands",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "7343b868-6dec-4a80-9a08-26965de174fb",
      Name: "ISLE OF MAN",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "cb6fa5ec-a11f-42a6-8404-a906f5173206",
      Name: "JERSEY",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "74f829fa-e742-4496-b652-bbd2450f5d2f",
      Name: "KENT",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "f3634e56-e374-4dd0-9359-daa036c06ac7",
      Name: "LANCASHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "f8c26606-3a70-47ed-a936-2f1c0b140eab",
      Name: "LANCHASHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "dfd525d9-2557-4ba7-b4f8-66c8dc60ebbc",
      Name: "LEICESTERSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "8e547f79-243d-4157-a355-cc2a0f2e1876",
      Name: "LINCOLNSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "877e44d8-d91d-4a04-9d3f-f51b94ebd9e2",
      Name: "MERSEYSIDE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "383c51e6-88ed-40cc-a70d-a83d89bda5d3",
      Name: "MIDDLESBROUGH",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "aceb9aa4-8d2a-4eb9-b8f1-1fe0d3b95892",
      Name: "NORFOLK",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "fa09fa11-faeb-4ac3-8c30-9b1ef11d3d85",
      Name: "NORTH YORKSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "18d0f5d3-63c6-4bb7-975e-b665ce565469",
      Name: "NORTHAMPTONSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "4e4ed2ad-4cc8-4a13-a1c0-0c980b54f734",
      Name: "NORTHERN IRELAND",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "45812148-ab70-4568-980b-4e0b630e5ba8",
      Name: "NORTHUMBERLAND",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "40737dab-cbe8-443a-b4b6-e67418d13f3a",
      Name: "Nottinghamshire",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "0a3a97b4-98d3-47f8-a549-2d532d0c37f2",
      Name: "OXFORDSHIRE",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "aa54b066-6c69-4fda-b156-535bf3f91ca2",
      Name: "REDCAR",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "28557fee-26f3-411c-974c-17bd82211559",
      Name: "RUTLAND",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "543226a4-4883-4a94-8051-b363ea06963d",
      Name: "SCOTLAND",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "9d6c6bcd-5590-42e9-90b3-14ecca08d3b6",
      Name: "SHROPSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "20826b21-9574-44af-9d05-053f0b193dc8",
      Name: "SOMERSET",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "78fb1a5d-1c6c-4a8a-a0e4-0f5cf79eb64a",
      Name: "SOUTH YORKSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "87eb2a18-f8d8-40fa-a2a2-374e5d44c2e6",
      Name: "STAFFORDSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "0812d35a-5ca7-4690-a760-5d38e1e059a7",
      Name: "STOCKTON ON TEES",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "6f36108d-fbac-471f-9bda-b08df44855ce",
      Name: "SUFFOLK",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "9e76f4f7-c6ca-452a-999d-91984f21d697",
      Name: "SURREY",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "bb01c5d2-b128-4877-a8ac-cca8bc447616",
      Name: "TYNE & WEAR",
      Value: '[  "0566245a-7ba1-4b5a-b03b-3dd33e051f46"]',
    },
    {
      Id: "f28ec5a1-8ad5-42d6-b9f7-1bb7e7abaaa8",
      Name: "WALES",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "d1cd9bce-ceaa-4c31-b361-ec1b5801b796",
      Name: "WARWICKSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "3c232dbf-9762-45d7-b04d-108b2d6d76f8",
      Name: "West Midlands ",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "438e50e7-70fa-4484-969f-9e930ffc0039",
      Name: "West SUSSEX",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "1c6a4a0f-0ea1-4d16-b0ec-4abc202849c7",
      Name: "WEST YORKSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
    {
      Id: "65ed4368-5875-41c7-8342-62a8d1a2e573",
      Name: "WILTSHIRE ",
      Value: '[  "60d2df036755e8de168d8db7"]',
    },
    {
      Id: "2b3cf649-5c9d-4cf1-8100-5bcdff41af0e",
      Name: "WORCESTERSHIRE",
      Value: '[  "8d780684-1524-4bda-b138-7c71a8591944"]',
    },
  ];

  var locationDataUae = [
    {
      Id: "f2dea03b-c29c-4d85-b4ff-1ebb2570d1e9",
      Name: "Premium Lounge Dubai",
      Code: "DWC",
    },
    {
      Id: "6209a866-f816-452f-8474-943fe5c6f516",
      Name: "Dubai",
      Code: "DXB",
    },
    {
      Id: "322a7804-d48d-4911-88bd-f79dc8731a25",
      Name: "Abu Dhabi",
      Code: "AUH",
    },
  ];
  var AppointmentCategoryIdDataUae = [
    {
      Id: "49e35a1a-d03c-463c-af72-e948e3373b7b",
      Name: "Doorstep Service",
      Code: "DOORSTEP_SERVICE",
      LocationId: "322a7804-d48d-4911-88bd-f79dc8731a25",
    },
    {
      Id: "49e35a1a-d03c-463c-af72-e948e3373b7b",
      Name: "Doorstep Service",
      Code: "DOORSTEP_SERVICE",
      LocationId: "6209a866-f816-452f-8474-943fe5c6f516",
    },
    {
      Id: "53c2a638-bbf4-4a0a-b17d-ab7a85c54c60",
      Name: "Prime Time",
      Code: "PRIME_TIME",
      LocationId: "322a7804-d48d-4911-88bd-f79dc8731a25",
    },
    {
      Id: "53c2a638-bbf4-4a0a-b17d-ab7a85c54c60",
      Name: "Prime Time",
      Code: "PRIME_TIME",
      LocationId: "6209a866-f816-452f-8474-943fe5c6f516",
    },
    {
      Id: "53c2a638-bbf4-4a0a-b17d-ab7a85c54c60",
      Name: "Prime Time",
      Code: "PRIME_TIME",
      LocationId: "f2dea03b-c29c-4d85-b4ff-1ebb2570d1e9",
    },
    {
      Id: "37ba2fe4-4551-4c7d-be6e-5214617295a9",
      Name: "Premium",
      Code: "CATEGORY_PREMIUM",
      LocationId: "f2dea03b-c29c-4d85-b4ff-1ebb2570d1e9",
    },
    {
      Id: "5c2e8e01-796d-4347-95ae-0c95a9177b26",
      Name: "Normal",
      Code: "CATEGORY_NORMAL",
      LocationId: "322a7804-d48d-4911-88bd-f79dc8731a25",
    },
    {
      Id: "5c2e8e01-796d-4347-95ae-0c95a9177b26",
      Name: "Normal",
      Code: "CATEGORY_NORMAL",
      LocationId: "6209a866-f816-452f-8474-943fe5c6f516",
    },
  ];
  var visaIdDataUae = [
    {
      Id: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Name: "National Visa",
      VisaTypeCode: "NATIONAL_VISA",
      AppointmentSource: "WEB_BLS",
      LocationId: "6209a866-f816-452f-8474-943fe5c6f516",
    },
    {
      Id: "5eecd807-fbfb-452a-8216-877248d32566",
      Name: "Short Term Visa(Maximum stay of 90 days)",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: "WEB_BLS",
      LocationId: "f2dea03b-c29c-4d85-b4ff-1ebb2570d1e9",
    },
    {
      Id: "f42bb322-74b5-447c-8071-c4f349ce094d",
      Name: "Short Term Visa(Maximum stay of 90 days)",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: "WEB_BLS",
      LocationId: "322a7804-d48d-4911-88bd-f79dc8731a25",
    },
    {
      Id: "31c757b0-fc9b-4acc-9d6d-590497759c5c",
      Name: "Short Term Visa(Maximum stay of 90 days)",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: "WEB_BLS",
      LocationId: "6209a866-f816-452f-8474-943fe5c6f516",
    },
  ];
  var visasubIdDataUae = [
    {
      Id: "d299ccdd-9125-46cc-8ee8-6ace7f483fff",
      Name: "Business Visa",
      Value: "31c757b0-fc9b-4acc-9d6d-590497759c5c",
      Code: "WEB_BLS",
    },
    {
      Id: "fc68cb8c-5a49-4fe7-8e60-fd9155464b2f",
      Name: "Business Visa",
      Value: "f42bb322-74b5-447c-8071-c4f349ce094d",
      Code: "WEB_BLS",
    },
    {
      Id: "25f063f9-f82d-4fee-8ecc-72612115728f",
      Name: "Business Visa",
      Value: "5eecd807-fbfb-452a-8216-877248d32566",
      Code: "WEB_BLS",
    },
    {
      Id: "4212fbb7-e6ea-4694-8fd8-d025e55ff28b",
      Name: "EEA/EU Spouse",
      Value: "31c757b0-fc9b-4acc-9d6d-590497759c5c",
      Code: "WEB_BLS",
    },
    {
      Id: "224d65dc-131f-470a-9920-b09530bb4a02",
      Name: "EEA/EU Spouse",
      Value: "f42bb322-74b5-447c-8071-c4f349ce094d",
      Code: "WEB_BLS",
    },
    {
      Id: "469d87fd-6c04-4e35-a663-d4978cd12e32",
      Name: "EEA/EU Spouse",
      Value: "5eecd807-fbfb-452a-8216-877248d32566",
      Code: "WEB_BLS",
    },
    {
      Id: "a0c5e485-8b6d-40a3-aee1-3ce23e96b219",
      Name: "Family Reunification Visa",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "7926a6c8-7cb8-49fd-9046-732f2f953af1",
      Name: "Family Reunification Visa",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "dbd4d401-4ed8-4a88-8f21-5c84c5382937",
      Name: "Family Reunification Visa",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "5f7f1193-2b68-47df-b626-21b18420d086",
      Name: "Highly Qualified Employees",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "570ae84f-7834-42d2-9f37-4b4a84428f94",
      Name: "Highly Qualified Employees",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "acbfd8a6-f5f2-4360-8194-f55ba0c88d48",
      Name: "Highly Qualified Employees",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "d517d6a9-3fed-4061-9e8f-5affea60f0e4",
      Name: "Highly Qualified Employees & relatives",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "68dd5a06-de82-4260-808e-b894baa33e03",
      Name: "Highly Qualified Employees & relatives",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "f4074a43-6f8a-481f-9717-e382e2cdc94f",
      Name: "Highly Qualified Employees & relatives",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "72ab7b8b-6192-4917-affe-28a9e99654e6",
      Name: "Highly Qualified Employees & relatives (RFI)",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "02d3c5c7-b2db-467e-b96a-e6e21d254c4e",
      Name: "Highly Qualified Employees & relatives (RFI)",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "82a47bfd-6d44-40cf-b8f9-bc34408f2743",
      Name: "Highly Qualified Employees & relatives (RFI)",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "1a41729d-207d-4109-aa01-6f692e0f2f03",
      Name: "Highly Qualified Employees & relatives (TAC)",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "4bcfb197-d9e2-4eb7-9baf-b8281be90c36",
      Name: "Highly Qualified Employees & relatives (TAC)",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "3a6d0f55-4f1d-4ffa-965b-754c295eb545",
      Name: "Highly Qualified Employees & relatives (TAC)",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "0cce0cff-c1bb-4921-b34d-7cbf9b07bb76",
      Name: "House Maid",
      Value: "31c757b0-fc9b-4acc-9d6d-590497759c5c",
      Code: "WEB_BLS",
    },
    {
      Id: "4de4beea-116b-4023-9b3a-c02a5ea68f1d",
      Name: "House Maid",
      Value: "5eecd807-fbfb-452a-8216-877248d32566",
      Code: "WEB_BLS",
    },
    {
      Id: "3c40822d-4998-4d45-af2f-2334effe80e3",
      Name: "House Maid",
      Value: "f42bb322-74b5-447c-8071-c4f349ce094d",
      Code: "WEB_BLS",
    },
    {
      Id: "69e58891-fc98-4868-9d88-8ef3d80c8645",
      Name: "Intra-company transfers & relatives",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "9caa9c22-62f9-4e28-b446-0202aef0f5c5",
      Name: "Intra-company transfers & relatives",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "7b01101c-bdf4-4b12-bf73-b7f04c340f8a",
      Name: "Intra-company transfers & relatives",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "15db40bd-36f9-43a8-8961-3c1f83e61191",
      Name: "Investers and Enterpreneurs",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "a951d190-8650-4e45-8232-bb2fe750b853",
      Name: "Investers and Enterpreneurs",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "f6188a50-e538-41c4-bbbc-c0acf5450334",
      Name: "Investers and Enterpreneurs",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "00739272-82a4-4f70-9c3d-61b32ff38de3",
      Name: "Investors in real estate & relatives",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "91b85736-941e-4843-9d65-39ca963230b1",
      Name: "Investors in real estate & relatives",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "1a775ad6-1302-421f-a249-d37b19bdfe1a",
      Name: "Investors in real estate & relatives",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "e68c92ca-db61-4e61-9450-08daaae0a3b1",
      Name: "Investors in real estate & relatives (RFI)",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "1fd905b6-914d-4ca3-8979-f34c991429fb",
      Name: "Investors in real estate & relatives (RIF)",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "7938e3dd-183f-4bf2-bdfa-c851d892234c",
      Name: "Investors in real estate & relatives (RIF)",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "5cfb70f5-41d7-46fd-890a-fb4e80162923",
      Name: "Investors in real estate & relatives (RIV)",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "d5a54788-c878-43ce-9d62-12898bf3e95a",
      Name: "Investors in real estate & relatives (RIV)",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "fe642bf5-ff18-413c-8c4c-9ca562fb22ff",
      Name: "Investors in real estate & relatives (RIV)",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "f5c2c078-092f-4d3c-baae-bdffddd48293",
      Name: "Medical Treatment Visa",
      Value: "f42bb322-74b5-447c-8071-c4f349ce094d",
      Code: "WEB_BLS",
    },
    {
      Id: "6663a6ae-6f98-4d94-ae08-7d201ccc02e5",
      Name: "Medical Treatment Visa",
      Value: "31c757b0-fc9b-4acc-9d6d-590497759c5c",
      Code: "WEB_BLS",
    },
    {
      Id: "c3190041-f2b0-41ff-b271-6c8a9cc65b7f",
      Name: "Medical Treatment Visa",
      Value: "5eecd807-fbfb-452a-8216-877248d32566",
      Code: "WEB_BLS",
    },
    {
      Id: "668eccda-ef5e-4ed9-b4b1-27893c5eafaa",
      Name: "Relatives of Investors",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "3153b9be-5f6c-413e-ac3d-13dd959d855e",
      Name: "Relatives of Investors",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "6f387ad5-b1be-4b99-b585-2982997bb4ee",
      Name: "Relatives of Investors",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "84a1efcd-0175-4ea3-81be-710344144a10",
      Name: "Relatives of TAC and TTI",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "e7b1f0be-2842-405d-b52d-bf803f3d4eb0",
      Name: "Relatives of TAC and TTI",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "8649d580-ca54-4c70-8cd7-19ea57b58b4e",
      Name: "Relatives of TAC and TTI",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "35f1d14c-e1b5-45c7-8eca-f46f87ab093f",
      Name: "RFI",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "4c9e484a-4034-445a-8bb5-f0377e737497",
      Name: "Self-employment Visa",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "b4a45cf6-e263-41ac-9dda-34a2c740661c",
      Name: "Self-employment Visa",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "27a8f6d2-c0da-4b76-b608-117e0f1d92e8",
      Name: "Self-employment Visa",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "5c7c83f6-4798-4f0a-a24e-e17bf23de3f7",
      Name: "Study Visa",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "0a7c0c59-144b-4cf1-ba9b-c0f3d05fc21a",
      Name: "Study Visa",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "5011f67f-4d47-4a43-8db9-f69ce33420cb",
      Name: "Study Visa",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "b3b4bb64-b72e-4aa4-b00b-6e44e89d79f8",
      Name: "Study Visa SLU",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "b1ff522d-f006-45a0-b8b0-f41ae49bd8ab",
      Name: "Study Visa SLU",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "5707c275-afc4-415a-80cd-ecc43980e655",
      Name: "Study Visa SLU",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "3f591f37-7d5f-411d-943c-6dba3729c15a",
      Name: "Study Visa SSU",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "ea4f3716-8517-44a7-959a-2a0cb62e20f7",
      Name: "Study Visa SSU",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "9e89cc5e-8ae7-4b1d-a99f-c58b41ad95fc",
      Name: "Study Visa SSU",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "f66b4e31-1426-4d4d-8580-a1e45b5f3f24",
      Name: "Tourist Visa",
      Value: "5eecd807-fbfb-452a-8216-877248d32566",
      Code: "WEB_BLS",
    },
    {
      Id: "11ec1f17-747d-419f-b5d3-5dd12ad62f6b",
      Name: "Tourist Visa",
      Value: "31c757b0-fc9b-4acc-9d6d-590497759c5c",
      Code: "WEB_BLS",
    },
    {
      Id: "1bfb0f3b-deb5-4439-9033-c1dccba0d6dc",
      Name: "Tourist Visa",
      Value: "f42bb322-74b5-447c-8071-c4f349ce094d",
      Code: "WEB_BLS",
    },
    {
      Id: "46a479d0-bc90-4875-bde9-ebd04faeb0bd",
      Name: "Transit Visa",
      Value: "31c757b0-fc9b-4acc-9d6d-590497759c5c",
      Code: "WEB_BLS",
    },
    {
      Id: "7709ceae-25d1-4c63-9324-49c4abd900a8",
      Name: "Transit Visa",
      Value: "5eecd807-fbfb-452a-8216-877248d32566",
      Code: "WEB_BLS",
    },
    {
      Id: "dec91ac7-9799-4da2-aee0-1d97688e288b",
      Name: "Transit Visa",
      Value: "f42bb322-74b5-447c-8071-c4f349ce094d",
      Code: "WEB_BLS",
    },
    {
      Id: "1939f946-727f-472f-a74b-75d77ce853a1",
      Name: "Working and Residence Permit",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "3e133945-4fd1-4b49-b389-ff6cd31dfd1e",
      Name: "Working and Residence Permit",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
    {
      Id: "720f5768-9f83-4554-b6af-08aa708aba70",
      Name: "Working and Residence Permit",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "3886ee14-f207-413e-8d1a-2e28a01b293b",
      Name: "Working and residence visas for employees",
      Value: "345ae470-a1a5-41e6-bfa2-1cace366b946",
      Code: "WEB_BLS",
    },
    {
      Id: "66dac8d0-0c53-4fd8-b01d-d1143965d92e",
      Name: "Working and residence visas for employees",
      Value: "edccfbf3-4918-4296-8ae2-a4ac98e2fad9",
      Code: "WEB_BLS",
    },
    {
      Id: "15487685-bcf8-477b-bd66-2b9034bf89de",
      Name: "Working and residence visas for employees",
      Value: "8fd4973b-8164-46cf-979b-5a12465b166d",
      Code: "WEB_BLS",
    },
  ];
  var missionDataUae = [
    {
      Id: "6208861e-a5c1-4a36-b748-a2d70ab29ffc",
      Name: "Abu Dhabi",
      Code: "AUH",
    },
  ];

  var locationDataMr = [
    {
      Id: "f9531922-769a-4a85-94f3-e03022f5a980",
      Name: "Nouadhibou",
      Code: "NDB",
    },
    {
      Id: "1e6935b2-8288-4577-b18a-c8f5f3125553",
      Name: "Nouakchott",
      Code: "NKC",
    },
  ];
  var AppointmentCategoryIdDataMr = [
    {
      Id: "5c2e8e01-796d-4347-95ae-0c95a9177b26",
      Name: "Normal",
      Code: "CATEGORY_NORMAL",
    },
    {
      Id: "37ba2fe4-4551-4c7d-be6e-5214617295a9",
      Name: "Premium",
      Code: "CATEGORY_PREMIUM",
    },
    {
      Id: "53c2a638-bbf4-4a0a-b17d-ab7a85c54c60",
      Name: "Prime Time",
      Code: "PRIME_TIME",
    },
  ];
  var visaIdDataMr = [
    {
      Id: "ae3232e3-42c2-4a4b-9ca7-264fe79790eb",
      Name: "National Visa",
      VisaTypeCode: "NATIONAL_VISA",
      AppointmentSource: "WEB_BLS",
      LocationId: "1e6935b2-8288-4577-b18a-c8f5f3125553",
    },
    {
      Id: "1d556646-51a9-406a-9267-24a257e3d7e0",
      Name: "National Visa",
      VisaTypeCode: "NATIONAL_VISA",
      AppointmentSource: "WEB_BLS",
      LocationId: "f9531922-769a-4a85-94f3-e03022f5a980",
    },
    {
      Id: "4ef6a279-0830-4d1f-a8d4-d1e9d10b885e",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: "WEB_BLS",
      LocationId: "f9531922-769a-4a85-94f3-e03022f5a980",
    },
    {
      Id: "0b5c23fe-df90-4b73-8c82-8c90b3c74ba7",
      Name: "Schengen Visa",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: "WEB_BLS",
      LocationId: "1e6935b2-8288-4577-b18a-c8f5f3125553",
    },
  ];
  var visasubIdDataMr = [
    {
      Id: "53bc0419-2e77-4b8e-b2c3-525cb33b5126",
      Name: "Airport Transit Visa",
      Value: "4ef6a279-0830-4d1f-a8d4-d1e9d10b885e",
      Code: "WEB_BLS",
    },
    {
      Id: "83352b66-4704-4bde-b4e8-f3c197f71853",
      Name: "Airport Transit Visa",
      Value: "0b5c23fe-df90-4b73-8c82-8c90b3c74ba7",
      Code: "WEB_BLS",
    },
    {
      Id: "a81f904f-d6cf-48d9-a5eb-581d2f250d3a",
      Name: "Business Visa",
      Value: "4ef6a279-0830-4d1f-a8d4-d1e9d10b885e",
      Code: "WEB_BLS",
    },
    {
      Id: "9a516acd-6d3a-4e2a-a782-f309a16f4e16",
      Name: "Business Visa",
      Value: "0b5c23fe-df90-4b73-8c82-8c90b3c74ba7",
      Code: "WEB_BLS",
    },
    {
      Id: "e1ce77cb-a07e-4b2b-8a73-83f6c2f44c07",
      Name: "Cultural Reasons",
      Value: "0b5c23fe-df90-4b73-8c82-8c90b3c74ba7",
      Code: "WEB_BLS",
    },
    {
      Id: "4315777e-a83a-4a4a-bb7e-1d4a83c1fdfb",
      Name: "Cultural Reasons",
      Value: "4ef6a279-0830-4d1f-a8d4-d1e9d10b885e",
      Code: "WEB_BLS",
    },
    {
      Id: "0f435d0e-bea4-4732-b258-9cc286d34b21",
      Name: "Employee Visa (Long Term)",
      Value: "1d556646-51a9-406a-9267-24a257e3d7e0",
      Code: "WEB_BLS",
    },
    {
      Id: "3d81ab5d-f2e8-466b-9588-247115d11dfb",
      Name: "Employee Visa (Long Term)",
      Value: "ae3232e3-42c2-4a4b-9ca7-264fe79790eb",
      Code: "WEB_BLS",
    },
    {
      Id: "5048d10d-ca5d-4d8a-a6af-628557b9a33b",
      Name: "Family member of EEA/EEU citizens (parents or children’s only)",
      Value: "0b5c23fe-df90-4b73-8c82-8c90b3c74ba7",
      Code: "WEB_BLS",
    },
    {
      Id: "e1e9f5c5-82b1-4032-999c-a8dbf09d2bca",
      Name: "Family member of EEA/EEU citizens (parents or children’s only)",
      Value: "4ef6a279-0830-4d1f-a8d4-d1e9d10b885e",
      Code: "WEB_BLS",
    },
    {
      Id: "ab4d94f1-00b5-442a-8060-5ccb275774ab",
      Name: "Family Member of EEA/EU",
      Value: "ae3232e3-42c2-4a4b-9ca7-264fe79790eb",
      Code: "WEB_BLS",
    },
    {
      Id: "32e0d937-da60-4f3f-845a-5ec7b1acf29c",
      Name: "Family Member of EEA/EU",
      Value: "1d556646-51a9-406a-9267-24a257e3d7e0",
      Code: "WEB_BLS",
    },
    {
      Id: "26302988-f1ad-4166-a4c1-b86d79fb1d65",
      Name: "Family Reunification Visa",
      Value: "1d556646-51a9-406a-9267-24a257e3d7e0",
      Code: "WEB_BLS",
    },
    {
      Id: "f9e94076-2b55-4b2b-a93d-5e3cd96ac444",
      Name: "Family Reunification Visa",
      Value: "ae3232e3-42c2-4a4b-9ca7-264fe79790eb",
      Code: "WEB_BLS",
    },
    {
      Id: "64c897b5-0f3e-451b-8b9b-d3462b6c602f",
      Name: "Medical Reasons",
      Value: "4ef6a279-0830-4d1f-a8d4-d1e9d10b885e",
      Code: "WEB_BLS",
    },
    {
      Id: "baeea056-fb5b-43e4-bf62-4e0293fa2eeb",
      Name: "Medical Reasons",
      Value: "0b5c23fe-df90-4b73-8c82-8c90b3c74ba7",
      Code: "WEB_BLS",
    },
    {
      Id: "ab5f9362-774f-437a-a3fc-3d8d9b315198",
      Name: "Non- working Residence",
      Value: "ae3232e3-42c2-4a4b-9ca7-264fe79790eb",
      Code: "WEB_BLS",
    },
    {
      Id: "0be8a21c-83ae-4b99-8935-4b3790e00dee",
      Name: "Non- working Residence",
      Value: "1d556646-51a9-406a-9267-24a257e3d7e0",
      Code: "WEB_BLS",
    },
    {
      Id: "67438e46-7c64-4e8b-bff7-f83de7e96d55",
      Name: "Others",
      Value: "4ef6a279-0830-4d1f-a8d4-d1e9d10b885e",
      Code: "WEB_BLS",
    },
    {
      Id: "c871082f-72b8-44dd-93f1-a57f049107cb",
      Name: "Others",
      Value: "0b5c23fe-df90-4b73-8c82-8c90b3c74ba7",
      Code: "WEB_BLS",
    },
    {
      Id: "163aa2c6-fd71-438c-8419-fd2c6a3dd2f9",
      Name: "Sports",
      Value: "0b5c23fe-df90-4b73-8c82-8c90b3c74ba7",
      Code: "WEB_BLS",
    },
    {
      Id: "176cd7da-a3b7-415f-b98f-12a72b7aceca",
      Name: "Sports",
      Value: "4ef6a279-0830-4d1f-a8d4-d1e9d10b885e",
      Code: "WEB_BLS",
    },
    {
      Id: "78845def-48cb-45ae-9747-bbe5e2626da4",
      Name: "Study Visa for more than 90 days and less than 6 months",
      Value: "ae3232e3-42c2-4a4b-9ca7-264fe79790eb",
      Code: "WEB_BLS",
    },
    {
      Id: "07a54932-75f9-4d0e-976c-e6202a572ed4",
      Name: "Study Visa for more than 90 days and less than 6 months",
      Value: "1d556646-51a9-406a-9267-24a257e3d7e0",
      Code: "WEB_BLS",
    },
    {
      Id: "47bcee69-6de8-4460-bf11-af96e326166b",
      Name: "Tourist Visa",
      Value: "4ef6a279-0830-4d1f-a8d4-d1e9d10b885e",
      Code: "WEB_BLS",
    },
    {
      Id: "49f0fa2b-284f-4710-8308-ea7b30050a9f",
      Name: "Tourist Visa",
      Value: "0b5c23fe-df90-4b73-8c82-8c90b3c74ba7",
      Code: "WEB_BLS",
    },
    {
      Id: "a33818cd-d0e8-42ff-8ab2-0652c02d8306",
      Name: "Transit Visa for Seamen",
      Value: "0b5c23fe-df90-4b73-8c82-8c90b3c74ba7",
      Code: "WEB_BLS",
    },
    {
      Id: "a8fd03c2-82c2-439a-8a69-9a08ff939537",
      Name: "Transit Visa for Seamen",
      Value: "4ef6a279-0830-4d1f-a8d4-d1e9d10b885e",
      Code: "WEB_BLS",
    },
  ];
  var missionDataMr = [];
  var jurisdictionDataMr = [
    {
      Id: "9f6b1184-50ce-4075-b372-b64ac488a0da",
      Name: "Nouadhibou",
      Value: '[  "f9531922-769a-4a85-94f3-e03022f5a980"]',
    },
    {
      Id: "40a8c108-ff6d-45f0-84e6-fe2ce6084c16",
      Name: "Nouakchott",
      Value: '[  "1e6935b2-8288-4577-b18a-c8f5f3125553"]',
    },
  ];

  var locationDataTn = [
    {
      Id: "8f72eb94-ff3f-46e5-9fce-8396157b72c8",
      Name: "Tunis",
      Code: "TUN",
    },
  ];
  var AppointmentCategoryIdDataTn = [
    {
      Id: "5c2e8e01-796d-4347-95ae-0c95a9177b26",
      Name: "Normal",
      Code: "CATEGORY_NORMAL",
    },
  ];
  var visaIdDataTn = [
    {
      Id: "be95c2a3-fd99-473a-8e92-3e9b28a4db8f",
      Name: "Schengen Visa - Others",
      VisaTypeCode: "SCHENGEN_VISA_OTHER",
      AppointmentSource: null,
      LocationId: "8f72eb94-ff3f-46e5-9fce-8396157b72c8",
    },
    {
      Id: "03eb6163-7b74-43f5-ac40-5852ea12fad4",
      Name: "Tourism",
      VisaTypeCode: "SCHENGEN_VISA",
      AppointmentSource: null,
      LocationId: "8f72eb94-ff3f-46e5-9fce-8396157b72c8",
    },
    {
      Id: "7d70489d-8205-4673-95b7-dcc15a876ff9",
      Name: "Visa for Libyan National",
      VisaTypeCode: "VISA_FOR_LIBYAN_NATIONAL",
      AppointmentSource: null,
      LocationId: "8f72eb94-ff3f-46e5-9fce-8396157b72c8",
    },
  ];
  var visasubIdDataTn = [
    {
      Id: "7923c5fc-70b2-496c-b90d-5bdce2625b4b",
      Name: "Business Visa",
      Value: "be95c2a3-fd99-473a-8e92-3e9b28a4db8f",
      Code: "WEB_BLS",
    },
    {
      Id: "397c5737-51a3-49b3-ac03-3dc493c492ef",
      Name: "Culture Visa",
      Value: "be95c2a3-fd99-473a-8e92-3e9b28a4db8f",
      Code: "WEB_BLS",
    },
    {
      Id: "b33861bb-3e58-436b-9b9f-36397cd1f866",
      Name: "Family Visa",
      Value: "be95c2a3-fd99-473a-8e92-3e9b28a4db8f",
      Code: "WEB_BLS",
    },
    {
      Id: "f6b31e83-dbc9-4072-a816-b2b9a7e202a5",
      Name: "Medical Visa",
      Value: "be95c2a3-fd99-473a-8e92-3e9b28a4db8f",
      Code: "WEB_BLS",
    },
    {
      Id: "b3b834e3-6f67-409e-90c0-7d15590f3542",
      Name: "Mission Visa",
      Value: "be95c2a3-fd99-473a-8e92-3e9b28a4db8f",
      Code: "WEB_BLS",
    },
    {
      Id: "3c222eef-a8b0-42c0-9ff6-e8bf5134ad45",
      Name: "National Family Reunification General Regime RFK Visa",
      Value: "ae9f0d18-3a65-48bd-90b1-f1fa5a7ac4c0",
      Code: "WEB_BLS",
    },
    {
      Id: "fc1e1f75-6c4d-4428-aba3-4446d5a5615d",
      Name: "National Visa",
      Value: null,
      Code: "RESIDENCE_AND_WORKVISA_FOR_HIGHLY_QUALIFIED_WORKERS",
    },
    {
      Id: "6e2da4bb-bd84-4687-86a3-3d2cece43791",
      Name: "National Visa",
      Value: null,
      Code: "NATIONAL_VISA",
    },
    {
      Id: "a7ebf42e-f8b0-4574-a8db-28e06383fed9",
      Name: "National Visa",
      Value: null,
      Code: "RESIDENCE_VISA_FOR_FAMILY_REUNIFICATION",
    },
    {
      Id: "668caac4-928e-41c3-991a-e38d697b65f4",
      Name: "National Visa",
      Value: null,
      Code: "RESIDENCE_AND_WORK_VISA_TTI",
    },
    {
      Id: "7dd80d82-7671-42dd-b221-26fa99ae25bd",
      Name: "National Visa",
      Value: null,
      Code: "LONG_TERM_STUDIES_VISA",
    },
    {
      Id: "0942051c-7fea-4331-a251-b7392102318d",
      Name: "National Visa",
      Value: null,
      Code: "NON_PROFIT_RESIDENCE_VISA",
    },
    {
      Id: "47baaf53-6274-4e57-8863-4f45d4466144",
      Name: "National Visa",
      Value: null,
      Code: "NATIONAL_VISA",
    },
    {
      Id: "2d8eb02b-e385-435e-90ed-43fddb7d7800",
      Name: "National Visa",
      Value: null,
      Code: "RESIDENCE_VISA_FOR_FAMILY_REUNIFICATION",
    },
    {
      Id: "6854d3f3-21a6-4f4c-bf60-d8d92e811c41",
      Name: "National Visa",
      Value: null,
      Code: "RESIDENCE_AND_WORKVISA_FOR_HIGHLY_QUALIFIED_WORKERS",
    },
    {
      Id: "d3c24ff3-2789-4dc2-b63e-a1c7600be009",
      Name: "National Visa",
      Value: null,
      Code: "WORK_VISA",
    },
    {
      Id: "f5bb0381-8d3b-4cda-a5f9-0657d80ba7d1",
      Name: "National Visa",
      Value: null,
      Code: "NON_PROFIT_RESIDENCE_VISA",
    },
    {
      Id: "777dcc38-3dba-4620-b5f6-bec2fc09cf23",
      Name: "National Visa",
      Value: null,
      Code: "LONG_TERM_STUDIES_VISA",
    },
    {
      Id: "d93dc3ad-e393-40f8-a800-a909d6509f80",
      Name: "National Visa",
      Value: null,
      Code: "WORK_VISA",
    },
    {
      Id: "8f9fe8b8-b9d8-4081-bea0-b5054fc9ef5d",
      Name: "National Visa",
      Value: null,
      Code: "RESIDENCE_AND_WORK_VISA_TTI",
    },
    {
      Id: "6ca8c748-c579-4184-965f-2d59ec9bb3fc",
      Name: "Official Visit Visa",
      Value: "be95c2a3-fd99-473a-8e92-3e9b28a4db8f",
      Code: "WEB_BLS",
    },
    {
      Id: "002ddc2e-fab8-4974-8960-db82b3e92d76",
      Name: "Schengen  Visa",
      Value: null,
      Code: "SCHENGEN_VISA",
    },
    {
      Id: "31ef5f44-1d90-412d-98ec-aed4d2e1f49b",
      Name: "Schengen  Visa",
      Value: null,
      Code: "STUDY_VISA",
    },
    {
      Id: "de7fbc78-d3e7-4c4c-8cc8-703b34fa2f3b",
      Name: "Schengen  Visa",
      Value: null,
      Code: "SPORT_VISA",
    },
    {
      Id: "85f1d4b9-f0f3-40e5-b867-92392a659cc2",
      Name: "Schengen  Visa",
      Value: null,
      Code: "TRANSIT_VISA",
    },
    {
      Id: "3d1cda2a-2c2f-448f-945f-65f55be65caf",
      Name: "Schengen  Visa",
      Value: null,
      Code: "BUSINESS_VISA",
    },
    {
      Id: "09df52d1-5da4-41ed-809d-68e61848dcae",
      Name: "Schengen  Visa",
      Value: null,
      Code: "FAMILY_VISA",
    },
    {
      Id: "c7066116-9f07-410c-a9d3-9df2f3740c70",
      Name: "Schengen  Visa",
      Value: null,
      Code: "SCHENGEN_VISA",
    },
    {
      Id: "37deb3ad-4f77-418d-b5c2-2687b18d687a",
      Name: "Schengen  Visa",
      Value: null,
      Code: "MISSION_VISA",
    },
    {
      Id: "b77ff9c0-8303-4090-9dfa-3a1208928a6d",
      Name: "Schengen  Visa",
      Value: null,
      Code: "BUSINESS_VISA",
    },
    {
      Id: "538ca6db-085c-4e53-aa7a-ba937e6d4bfa",
      Name: "Schengen  Visa",
      Value: null,
      Code: "MEDICAL_VISA",
    },
    {
      Id: "85b5e5c4-04b7-43e7-9b96-4d1d619705cb",
      Name: "Schengen  Visa",
      Value: null,
      Code: "TRANSIT_VISA",
    },
    {
      Id: "9687546d-3780-47a6-931e-66835b82e26b",
      Name: "Schengen  Visa",
      Value: null,
      Code: "STUDY_VISA",
    },
    {
      Id: "bcf71fb3-e0b0-4ed6-a585-6041069f4dc8",
      Name: "Schengen  Visa",
      Value: null,
      Code: "MEDICAL_VISA",
    },
    {
      Id: "3dca81b7-d031-4255-9340-85fcc55e254d",
      Name: "Schengen  Visa",
      Value: null,
      Code: "FAMILY_VISA",
    },
    {
      Id: "2e940992-2cba-4e8f-8d7b-f397b44c4e95",
      Name: "Schengen  Visa",
      Value: null,
      Code: "MISSION_VISA",
    },
    {
      Id: "fe7c59df-5186-4af3-8f59-92fe3b70211f",
      Name: "Schengen  Visa",
      Value: null,
      Code: "SPORT_VISA",
    },
    {
      Id: "27c18817-a5a4-415d-9612-dccda0dd0b6d",
      Name: "Sport Visa",
      Value: "be95c2a3-fd99-473a-8e92-3e9b28a4db8f",
      Code: "WEB_BLS",
    },
    {
      Id: "ba889d27-3695-478d-a4c1-94e262a8453a",
      Name: "Study Visa",
      Value: "be95c2a3-fd99-473a-8e92-3e9b28a4db8f",
      Code: "WEB_BLS",
    },
    {
      Id: "fcd39a64-92c2-4bb1-9aaa-8b20f3a34350",
      Name: "Tourism Visa",
      Value: "03eb6163-7b74-43f5-ac40-5852ea12fad4",
      Code: "WEB_BLS",
    },
    {
      Id: "df745546-71fc-4ffc-9d8d-8d0cf501618b",
      Name: "Transit Visa",
      Value: "be95c2a3-fd99-473a-8e92-3e9b28a4db8f",
      Code: "WEB_BLS",
    },
    {
      Id: "beb1b923-67de-4c34-9840-fc92f072aa01",
      Name: "Visa For Libyan National",
      Value: "7d70489d-8205-4673-95b7-dcc15a876ff9",
      Code: "WEB_BLS",
    },
  ];
  var missionDataTn = [
    {
      Id: "f87b6ddb-1bb8-4efd-b671-b99fcfe37bcb",
      Name: "Embassy-Tunisia",
      Code: "EMBASSY-TUNISIA",
    },
  ];

  let finalLocationData,
    finalVisaIdData,
    finalAppointmentCategoryData,
    finalMissionData,
    finalVisaSubIdData,
    finalJurisdictionIdData = [];

  let cc = country,
    cc2 = country;

  if (cc === "algeria") (finalLocationData = locationDataDza), (finalVisaIdData = visaIdDataDza), (finalAppointmentCategoryData = AppointmentCategoryIdDataDza), (finalMissionData = missionDataDza), (finalVisaSubIdData = visasubIdDataDza);
  else if (cc === "morocco") (finalLocationData = locationDataMar), (finalVisaIdData = visaIdDataMar), (finalAppointmentCategoryData = AppointmentCategoryIdDataMar), (finalMissionData = missionDataMar), (finalVisaSubIdData = visasubIdDataMar);
  else if (cc === "chn") (finalLocationData = locationDataChn), (finalVisaIdData = visaIdDataChn), (finalAppointmentCategoryData = AppointmentCategoryIdDataChn), (finalMissionData = missionDataChn), (finalVisaSubIdData = visasubIdDataChn);
  else if (cc2 === "egypt") (finalLocationData = locationDataEgy), (finalVisaIdData = visaIdDataEgy), (finalAppointmentCategoryData = AppointmentCategoryIdDataEgy), (finalMissionData = missionDataEgy), (finalVisaSubIdData = visasubIdDataEgy);
  else if (1) {
    if (cc2 === "russia") (finalLocationData = locationDataRussia), (finalVisaIdData = visaIdDataRussia), (finalAppointmentCategoryData = AppointmentCategoryIdDataRussia), (finalMissionData = missionDataRussia), (finalVisaSubIdData = visasubIdDataRussia);
    else if (cc2 === "uk")
      (finalLocationData = locationDataUk), (finalVisaIdData = visaIdDataUk), (finalAppointmentCategoryData = AppointmentCategoryIdDataUk), (finalMissionData = missionDataUk), (finalVisaSubIdData = visasubIdDataUk), (finalJurisdictionIdData = jurisdictionDataUk);
    else if (cc2 === "uae") (finalLocationData = locationDataUae), (finalVisaIdData = visaIdDataUae), (finalAppointmentCategoryData = AppointmentCategoryIdDataUae), (finalMissionData = missionDataUae), (finalVisaSubIdData = visasubIdDataUae);
    else if (cc2 === "tunisia") (finalLocationData = locationDataTn), (finalVisaIdData = visaIdDataTn), (finalAppointmentCategoryData = AppointmentCategoryIdDataTn), (finalMissionData = missionDataTn), (finalVisaSubIdData = visasubIdDataTn);
    else if (cc2 === "mauritania")
      (finalLocationData = locationDataMr), (finalVisaIdData = visaIdDataMr), (finalAppointmentCategoryData = AppointmentCategoryIdDataMr), (finalMissionData = missionDataMr), (finalVisaSubIdData = visasubIdDataMr), (finalJurisdictionIdData = jurisdictionDataMr);
  } else {
    finalLocationData = [];
    finalVisaIdData = [];
    finalAppointmentCategoryData = [];
    finalMissionData = [];
    finalVisaSubIdData = [];
  }

  let obj = {
    locationData: typeof locationData === "undefined" || true ? finalLocationData : locationData,
    AppointmentCategoryIdData: typeof AppointmentCategoryIdData === "undefined" || true ? finalAppointmentCategoryData : AppointmentCategoryIdData,
    visaIdData: typeof visaIdData === "undefined" || true ? finalVisaIdData : visaIdData,
    visasubIdData: typeof visasubIdData === "undefined" || true ? finalVisaSubIdData : visasubIdData,
    missionData: typeof missionData === "undefined" || true ? finalMissionData : missionData,
    jurisdictionData: typeof jurisdictionData === "undefined" || true ? finalJurisdictionIdData : jurisdictionData,
  };

  return obj;

  const meta = {};

  const reducer = (data) =>
    data.reduce((acc, v) => {
      if (acc[v.Name]) {
        acc[v.Name].push(v);
      } else {
        acc[v.Name] = [v];
      }
      return acc;
    }, {});

  meta.algeria = {
    visa_center_location: reducer(locationDataDza),
    visa_type: reducer(visaIdDataDza),
    visa_subtype: reducer(visasubIdDataDza),
    mission: reducer(missionDataDza),
    visa_appointement_category: reducer(AppointmentCategoryIdDataDza),
  };

  meta.morocco = {
    visa_center_location: reducer(locationDataMar),
    visa_type: reducer(visaIdDataMar),
    visa_subtype: reducer(visasubIdDataMar),
    mission: reducer(missionDataMar),
    visa_appointement_category: reducer(AppointmentCategoryIdDataMar),
  };

  meta.egypt = {
    visa_center_location: reducer(locationDataEgy),
    visa_type: reducer(visaIdDataEgy),
    visa_subtype: reducer(visasubIdDataEgy),
    mission: reducer(missionDataEgy),
    visa_appointement_category: reducer(AppointmentCategoryIdDataEgy),
  };

  meta.china = {
    visa_center_location: reducer(locationDataChn),
    visa_type: reducer(visaIdDataChn),
    visa_subtype: reducer(visasubIdDataChn),
    mission: reducer(missionDataChn),
    visa_appointement_category: reducer(AppointmentCategoryIdDataChn),
  };

  meta.england = {
    visa_center_location: reducer(locationDataUk),
    visa_type: reducer(visaIdDataUk),
    visa_subtype: reducer(visasubIdDataUk),
    mission: reducer(missionDataUk),
    visa_appointement_category: reducer(AppointmentCategoryIdDataUk),
  };

  meta.russia = {
    visa_center_location: reducer(locationDataRussia),
    visa_type: reducer(visaIdDataRussia),
    visa_subtype: reducer(visasubIdDataRussia),
    mission: reducer(missionDataRussia),
    visa_appointement_category: reducer(AppointmentCategoryIdDataRussia),
  };

  meta.uae = {
    visa_center_location: reducer(locationDataUae),
    visa_type: reducer(visaIdDataUae),
    visa_subtype: reducer(visasubIdDataUae),
    mission: reducer(missionDataUae),
    visa_appointement_category: reducer(AppointmentCategoryIdDataUae),
  };

  meta.tunisia = {
    visa_center_location: reducer(locationDataTn),
    visa_type: reducer(visaIdDataTn),
    visa_subtype: reducer(visasubIdDataTn),
    mission: reducer(missionDataTn),
    visa_appointement_category: reducer(AppointmentCategoryIdDataTn),
  };

  meta.mauritania = {
    visa_center_location: reducer(locationDataMr),
    visa_type: reducer(visaIdDataMr),
    visa_subtype: reducer(visasubIdDataMr),
    mission: reducer(missionDataMr),
    visa_appointement_category: reducer(AppointmentCategoryIdDataMr),
  };

  return meta[country] || meta;
}

// console.log(CaptchaSolver.getChallengeData(require('fs').readFileSync('./a').toString
