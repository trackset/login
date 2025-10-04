const utils = require("../utils/utils.js");
const uiapi = require("../../ui/api.js");

class LoginMorocco {
  constructor(httpManager) {
    this.httpManager = httpManager;
  }

  static get WORK_ID() {
    return 1;
  }

  async start() {
    process.vars.work_state = this.constructor.WORK_ID;
    return this.page1();
  }

  async page1(login_response = null) {
    if (process.vars.COUNTRY === "algeria" && !this.httpManager.cookieJar.visitorId_current) {
      // if (process.env.randomVisitorId) {
      this.httpManager.cookieJar.visitorId_current = Math.random().toString().substring(2, 12)
      process.vars.COOKIES_JAR.visitorId_current = Math.random().toString().substring(2, 12)
      // } else {
      //   await this.httpManager.get_(process.vars.BASE_URL + process.vars.URL_PATH_PART1)
      // }
    }

    if (["mauritania", "senegal"].includes(process.vars.COUNTRY) && !process.vars.LANG_CHANGED) {
      process.dynamic.EE.emit("info", "login", "changing lang");

      let ok;
      while (!ok) {
        let resp = await this.httpManager.post_("/Global/account/ChangeLanguage?hdnLang=en-US", {});
        if (resp.status !== 200) await utils.wait(1500);
        else ok = true;
      }
      process.vars.LANG_CHANGED = true;

      // process.dynamic.EE.emit("info", "login", "login");
    }
    process.vars.logged_in = false;
    process.dynamic.PASSBYFORM = false;

    // get login
    let login_page_url = await this.page1_url();
    if (!process.vars.VTV_URL && !process.env.LOGIN_SHADOW) {
      process.dynamic.EE.emit("info", "login", "getting login");
      login_response = login_response || (await this.httpManager.get_(login_page_url, {
        headers: {
          referer: process.vars.BASE_URL + process.vars.URL_PATH_PART1 + "/appointment/livenessrequest",
        },
      }));
    }

    if (process.env.LOGIN_SHADOW && process.vars.COUNTRY === "morocco") {
      process.dynamic.EE.emit("info", "login1", "shadow login");
      let at = Date.now();
      while (Date.now() - at < 60000) {
        let r = await fetch("http://88.99.242.58:3990/get")
          .then((res) => res.json())
          .catch((e) => ({}));
        if (r?.success) {
          process.vars.VTV_URL = `/${process.vars.URL_PATH_PART1}/appointment/newappointment`;
          process.vars.LOGIN_CAPTCHA_URL = `/${process.vars.URL_PATH_PART1}/newcaptcha/logincaptcha?data=${r.data}`;
          return this.page2();
        }
        await utils.wait(1000);
      }
    }

    if (!login_response) {
      process.dynamic.EE.emit("info", "login", "getting login");
      login_response = login_response || (await this.httpManager.get_(login_page_url));
    }

    // check login
    let action = await this.page1_check(login_response, login_page_url);
    if (action) return action;

    process.vars.LOGIN_ACCESS_N++;

    // post login
    const data = this.page1_formdata(login_response.body);
    if (process.env.waitbeforelogin && (process.vars.COUNTRY === "morocco" || process.env.waitbeforeloginall)) {
      utils.info("login", "waiting before login " + process.env.waitbeforelogin)

      await utils.wait(parseInt(process.env.waitbeforelogin))
    }
    process.dynamic.EE.emit("info", "login1", "posting login");
    const response = await this.httpManager.post_(process.vars.LOGIN_ACTION, data);

    // verify post
    return this.page1_verify(response);
  }

  async page1_check(login_response, login_page_url) {
    if (login_response.status !== 200) {
      if (login_response.status === 301) {
        process.dynamic.EE.emit("info", "login", "redirect 301 login");
        return this.page1();
      } else if (login_response.status === 302) {
        process.dynamic.EE.emit("info", "login", "redirect 302 login");
        return this.page1();
      } else if (login_response.status === 202) {
        let waiting = parseInt(process.env.login_202_wait || 7000)
        process.dynamic.EE.emit("info", "login", "login 202, waiting " + waiting + " ms");
        await utils.wait(waiting);
        process.dynamic.EE.emit("done", "any_login");
        throw new Error("ignore");
      }
      process.dynamic.EE.emit("info", "login1", "get: status: " + login_response.status);
      process.dynamic.EE.emit("done", "any_login");
      throw new Error("ignore");
    }

    // occasional
    if (login_page_url.includes("9NqNa27GWQ9FvyH58OoM1VqKde4vSyKIeGjHlZnHhRU") || login_page_url.includes("HU7zqU0yCxX3GNnx4emgb8d")) {
      process.vars.LOGIN_TO_CALENDAR = undefined
    }
    const reason = utils.save_errorCodes(login_response.body, login_page_url);
    if (!reason) return;

    if (reason?.includes("mail does not exist")) {
      await uiapi.markaccount({ country: process.vars.COUNTRY, email: process.vars.EMAIL, marks: { invalid: true, notexist: true } });
      throw new Error("email does not exist");
    } else {
      process.dynamic.EE.emit("info", "login1", "error: " + reason);
      if (reason.includes("error occured while processing")) {
        if (!(this.login_page_error_occured >= 5)) {
          await utils.wait(1000);
          this.login_page_error_occured = (this.login_page_error_occured || 0) + 1;
          return;
        } else {
          process.dynamic.EE.emit("info", "login1", "processing error");
          await utils.wait(15000);
          return;
        }
        await utils.wait(10000);
      }
      await utils.wait(3000);
    }
  }

  async page1_url() {
    let login_page_url = process.vars.LOGIN_URL_REDIRECT || process.vars.LOGIN_URL;
    if (login_page_url.startsWith("http://")) {
      process.dynamic.EE.emit("info", "login", "http url");
      login_page_url = login_page_url.replace("http://", "https://");
    }
    process.vars.LOGIN_URL_REDIRECT = undefined;
    return login_page_url;
  }

  async page1_verify(response) {
    const location = response.headers.location;
    if (location?.toLowerCase().includes(process.vars.LOGIN_URL.toLowerCase())) {
      process.dynamic.EE.emit("info", "login1", "post: redirect: login");

      if (location.includes("7V1lWbty49gjGor1oaern95Z8")) {
        const cookies_jar = Object.keys(process.vars.COOKIES_JAR).find(c => c.includes('Cookies'));
        // if (cookies_jar && process.vars.COOKIES_JAR[cookies_jar] && ['morocco', 'algeria'].includes(process.vars.COUNTRY)) {
        //   process.dynamic.PASSBYFORM = true;
        //   await utils.done("newapp_appform");
        //   return;
        // }
        this.session_invalid_counter = this.session_invalid_counter || 0;
        if (Date.now() - this.session_invalid_last_seen > 30 * 1000) this.session_invalid_counter = 0;
        if (++this.session_invalid_counter > 5) {
          process.dynamic.EE.emit("info", "login1", "session invalid cooldown");
          // this.httpManager.cookieJar = {}
          await utils.wait(10000);
        }
        this.session_invalid_last_seen = Date.now();
      }

      process.vars.LOGIN_URL_REDIRECT = response.headers.location;
      return this.page1();
    } else {
      process.vars.LOGIN_CAPTCHA_URL = response.headers.location;
      return this.page2();
    }
  }

  page1_formdata(login_html) {
    process.vars.LOGIN_ACTION = utils.Regexes.get("form_action", login_html)?.toLowerCase();
    process.vars.VTV_URL = utils.Regexes.get("vtvURL", login_html)?.toLowerCase();

    const rvt_form_elmeent = utils.Regexes.val("__RequestVerificationToken", login_html);
    const id_form_element = utils.Regexes.val("Id", login_html);

    try {
      const [responseData, email_key] = utils.LoginSolver.solve(login_html);
      responseData[email_key] = process.vars.EMAIL;

      return utils.FormData.encode_object({
        ...responseData,
        ResponseData: JSON.stringify(responseData),
        ReturnUrl: "",
        Id: id_form_element,
        __RequestVerificationToken: rvt_form_elmeent,
      });
    } catch (e) {
      utils.info("login", "can't parse challenge");
      setTimeout(() => utils.done("any_login"), 3000);
      throw new Error("ignore");
    }
  }

  async page2() {
    process.dynamic.EE.emit("info", "login2", "getting login captcha");
    if (process.vars.WORK_TYPE === "login") {
      process.dynamic.EE.emit("info", "login2", "saving login captcha");
      const cdata = new URLSearchParams(process.vars.LOGIN_CAPTCHA_URL?.split("?")[1]).get("data");
      let r = await fetch("http://88.99.242.58:3990/save", { method: "post", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: cdata }) })
        .then((res) => res.json())
        .catch((e) => {
          return false;
        });
      if (r?.success) {
        process.dynamic.EE.emit("info", "login2", "login captcha saved");
      } else process.dynamic.EE.emit("info", "login2", "login captcha not saved: " + r);
      await utils.wait(15000);
      return this.page1;
    }
    const response_get = await this.httpManager.get_(process.vars.LOGIN_CAPTCHA_URL);

    await this.page2_check(response_get);

    process.dynamic.EE.emit("info", "login2", "solving login captcha");
    const data = await this.page2_formdata(response_get.body);

    process.dynamic.EE.emit("info", "login2", "posting login captcha");
    if (process.env.waitbeforelogin2 && (process.vars.COUNTRY === "morocco" || process.env.waitbeforelogin2all)) {
      utils.info("login", "waiting before login2 " + process.env.waitbeforelogin2)

      await utils.wait(parseInt(process.env.waitbeforelogin2))
    }
    const response = await this.httpManager.post_(process.vars.LOGIN_CAPTCHA_ACTION, data);

    return this.page2_verify(response);
  }

  async page2_check(response_get) {
    utils.check_disconnect(response_get);

    if (response_get.status !== 200) {
      process.dynamic.EE.emit("info", "login2", "get: status: " + response_get.status);
      throw new Error("login2 get unknown status");
    } else {
      await this.page2_check_err_code(response_get.body, process.vars.LOGIN_CAPTCHA_URL);
    }
  }

  async page2_formdata(captcha_html) {
    try {
      const responseData = utils.LoginSolver.solve(captcha_html, process.vars.PASSWORD);
      const Param = utils.Regexes.val("Param", captcha_html);
      const { id, captcha, rvt, action } = utils.Captcha.extractCaptchaParams(captcha_html);
      if (!Param || !rvt || !action || !id) throw new Error();

      process.vars.LOGIN_CAPTCHA_ACTION = action;

      const selectedImages = await utils.CaptchaSolver.solve(captcha_html);
      if (selectedImages === false) throw new Error();
      else if (!selectedImages) {
        process.dynamic.EE.emit("info", "login2", "no selected images");
        await utils.wait(2100);
        return this.page2_formdata(captcha_html);
      }

      return utils.FormData.encode_object({
        SelectedImages: selectedImages,
        Id: id,
        ReturnUrl: "",
        ResponseData: JSON.stringify(responseData),
        Param: utils.decodeHtmlEntities(Param),
        __RequestVerificationToken: rvt,
      });
    } catch (e) {
      utils.info("login2", "bad captcha challenge");
      await utils.wait(3000);
      utils.done("any_login");
      throw new Error("bad captcha challenge");
    }
  }

  page2_verify(response) {
    const location = response.headers?.location?.toLowerCase();

    if (!location || (response.status !== 200 && response.status !== 302)) {
      process.dynamic.EE.emit("info", "login2", "bad login status/location: " + response.status);
      setTimeout(() => process.dynamic.EE.emit("done", "any_login"), 1000);
    } else if (location.includes("/newcaptcha")) {
      process.vars.LOGIN_CAPTCHA_URL = response.headers.location;
      process.dynamic.EE.emit("info", "login2", "post: redirect: login2");
      return this.page2();
    } else if (location.includes(process.vars.LOGIN_URL.toLowerCase())) {
      process.vars.LOGIN_URL_REDIRECT = response.headers.location;
      process.dynamic.EE.emit("info", "login2", "post: redirect: login1");
      return this.page1();
    } else if (!response.headers["set-cookie"]?.toString()?.includes(".AspNetCore.Cookies")) {
      process.dynamic.EE.emit("info", "login2", "post: unknown");
      setTimeout(() => process.dynamic.EE.emit("done", "any_login"), 1000);
      throw new Error("login2 post unknown", 62);
    } else {
      process.vars.logged_in = true;
      if (process.vars.LAST_CALENDAR_PROXY !== process.vars.PROXY_IN_USE) {
        process.vars.LOGIN_TO_CALENDAR = undefined
        process.vars.LOGIN_TO_CALENDAR_GET = undefined
      }
      if (process.vars.WORK_TYPE === "email") {
        process.dynamic.EE.emit("info", "work", "email ok")
        return
      }
      if (process.vars.LOGIN_TO_CALENDAR) process.dynamic.EE.emit("done", "any_calendar");
      else process.dynamic.EE.emit("done", "login");
    }
  }

  async page2_check_err_code(body, url) {
    const reason = utils.save_errorCodes(body, url);
    if (!reason) {
      this.captcha_page_error_occured = 0;
      return;
    }

    if (reason.includes("Invalid captcha selection")) {
      process.dynamic.EE.emit("info", "login2", "invalid captcha selection");
      return;
    }
    if (reason.includes("submission is invalid")) {
      process.dynamic.EE.emit("info", "login2", "submission is invalid");
      return;
    } else if (reason.includes("An error occured while processing your request")) {
      if (!(this.captcha_page_error_occured >= 5)) {
        this.captcha_page_error_occured = (this.captcha_page_error_occured || 0) + 1;
        return;
      } else {
        process.dynamic.EE.emit("info", "login2", "processing error");
        await utils.wait(15000);
        return;
      }
      throw new Error("processing errors >5");
    } else if (reason.includes("The password is invalid")) {
      await uiapi.markaccount({ country: process.vars.COUNTRY, email: process.vars.EMAIL, marks: { invalid: true } });
      throw new Error("invalid password");
    } else if (reason.includes("maximum number of allowed captcha submissions")) {
      process.dynamic.EE.emit("info", "login2", "captcha limit reached");
      utils.wait(10000).then((_) => {
        process.dynamic.EE.emit("done", "disconnected");
      });
      throw new Error("captcha 2 maximum submissions");
    } else if (reason.includes("Invalid response data")) {
      process.dynamic.EE.emit("info", "login2", "invalid response data");
      return;
    } else {
      throw new Error("unknown page2 error: " + reason);
    }
  }
}

module.exports = LoginMorocco;
