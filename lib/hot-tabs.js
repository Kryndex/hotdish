const { data } = require("sdk/self");
const { Class } = require('sdk/core/heritage');
const tabs = require("sdk/tabs");
const windows = require("sdk/windows");
const { EventMethods, assert, bind, setHandlers, decodeQuery, copyMethods, normalizeUrl } = require("utils");
const { winIdFromTab, getOuterId } =  require("tracking-utils");
const { getFavicon } = require("sdk/places/favicon");
const { all, defer } = require('sdk/core/promise');
const { isForeground } = require("foreground-window");
const { setTimeout } = require("sdk/timers");
const { getTabs, getTabId } = require("sdk/tabs/utils");


var viewerScript = data.load("mirror/viewer.js");
var togetherJsCss = data.load("togetherjs-overrides.css");

var allTabSets = {};

var activated = false;

function activate() {
  if (activated) {
    return;
  }
  activated = true;
  let tabEvents = ["pageshow", "activate", "close", "open"];
  tabEvents.forEach(function (tabEvent) {
    tabs.on(tabEvent, function (sdkTab) {
      var windowId = winIdFromTab(sdkTab);
      var tabSet = allTabSets[windowId];
      if (tabSet) {
        var tabObj = tabSet.tabForSdkTab(sdkTab, tabEvent == "close");
        if (! tabObj) {
          return;
        }
        if (tabEvent == "pageshow") {
          tabObj.lastPageShowAt = Date.now();
        } else if (tabEvent == "activate") {
          tabObj.lastActivateAt = Date.now();
        } else if (tabEvent == "close") {
          tabObj.closedAt = Date.now();
        } else if (tabEvent == "open") {
          tabObj.openAt = Date.now();
        }
        tabObj.lastEventAt = Date.now();
        if (tabEvent == "close" && tabObj.state() == "presenting") {
          tabSet.emit("presentingOff", tabObj);
        }
        tabSet.emit(tabEvent, tabObj);
        if (tabEvent == "close") {
          // Do this after the event is emitted
          tabObj.destroy();
        }
      }
    });
  });
}

exports.TabSet = Class({
  /* Currently a TabSet is equivalent to a window, because that's our
     sharing metaphor.  But otherwise we treat it as basically a group
     of tabs, the window details shouldn't be exposed */

  extends: EventMethods,

  initialize: function (group, domWindow, sdkWindow) {
    activate();
    this.group = group;
    this.domWindow = domWindow;
    this.windowId = getOuterId(domWindow);
    this.sdkWindow = sdkWindow;
    assert(! allTabSets[this.windowId], "Recreating TabSet with a new window");
    allTabSets[this.windowId] = this;
    this._tabsById = {};
    this._tabsByExternalId = {};
    this.cullMirroredTabs();
    // Load all tabs, and create tab objects for future tabs:
    this.allTabs();
    this.on("close", (function (tab) {
      tab.destroy();
    }).bind(this));
    // change the Tab state to Presenter, Spectator or Shared tab
    //this.on("stateChange", function (tab) {
      //var state = tab.state();
      //if (state == "presenting") {
        //changeStyleToPresenting(tab.sdkTab);
      //}
  },

  //changeStyleToPresenting: function () {
    //$(".hotdish tab.tabbrowser-tab").css("border-top","1px solid #2ecc71");
  //}

  destroy: function () {
    for (var id in this._tabsById) {
      this._tabsById[id].destroy();
    }
    this.sdkWindow = null;
    this.domWindow = null;
    delete allTabSets[this.windowId];
  },

  cullMirroredTabs: function () {
    var toDelete = [];
    for each (var tab in this.sdkWindow.tabs) {
      if (tab.url.indexOf(data.url("mirror/blank.html")) != -1) {
        toDelete.push(tab);
      }
    }
    toDelete.forEach(function (t) {
      t.close();
    });
  },

  tabForSdkTab: function (sdkTab, force) {
    assert(! (sdkTab instanceof exports.Tab), "Tried tabForSdkTab with hot-tabs.Tab");
    var sdkTabWindowId = winIdFromTab(sdkTab);
    if (this._tabsById[sdkTab.id]) {
      return this._tabsById[sdkTab.id];
    }
    if (! force && sdkTabWindowId != this.windowId) {
      console.warn("Tried to get a tab that doesn't match my (" + this.windowId + ") id:", sdkTabWindowId);
      return null;
    }
    var tab = exports.Tab(this, sdkTab);
    this._tabsById[sdkTab.id] = tab;
    return tab;
  },

  tabForId: function (id) {
    var prefix = this.group.clientId + "_";
    if (id.indexOf(prefix) !== 0) {
      return null;
    }
    var shortId = id.substr(prefix.length);
    return this._tabsById[shortId];
  },

  allTabs: function () {
    var result = [];
    for each (var tab in this.sdkWindow.tabs) {
      result.push(this.tabForSdkTab(tab));
    }
    result.sort(function (a, b) {return a.lastLoadedTime < b.lastLoadedTime;});
    return result;
  },

  allTabsJson: function () {
    return all(this.allTabs().map(function (t) {return t.getJson();}));
  },

  launchViewer: function (tabId) {
    var deferred = defer();
    var url = data.url("mirror/blank.html");
    url += "?tabId=" + encodeURIComponent(tabId);
    tabs.open({
      url: url,
      inBackground: true,
      onOpen: (function (sdkTab) {
        var tab = this.tabForSdkTab(sdkTab);
        tab.viewerTabId = tabId;
        deferred.resolve(tab);
      }).bind(this)
    });
    return deferred.promise;
  },

  activeTab: function () {
    return this.tabForSdkTab(tabs.activeTab);
  },

  tabWithUrl: function (url) {
    /* Return a tab with the given URL (or null if none found) */
    url = normalizeUrl(url);
    url = url.replace(/#.*/, "");
    for each (var tab in this.allTabs()) {
      if (tab.url().replace(/#.*/, "") == url) {
        return tab;
      }
    }
    return null;
  },

  tabMirroring: function (tabId) {
    /* Returns a tab mirroring the given tabId, or null if none found */
    for each (var tab in this.allTabs()) {
      if (tabId == tab.mirrorTabId()) {
        return tab;
      }
    }
    return null;
  },

  open: function (options) {
    var reactivate;
    var deferred = defer();
    if (! this.activeTab()) {
      // Arg, active window isn't ours
      reactivate = windows.activeWindow;
      this.sdkWindow.activate();
    }
    var oldOnOpen = options.onOpen;
    options.onOpen = (function (sdkTab) {
      var tab = this.tabForSdkTab(sdkTab);
      deferred.resolve(tab);
      if (oldOnOpen) {
        oldOnOpen(tab);
      }
    }).bind(this);
    tabs.open(options);
    if (reactivate) {
      reactivate.activate();
    }
    return deferred.promise;
  },

  activateLiveForUrl: function (url) {
    if (url.search(/^about:/) === 0) {
      return;
    }
    url = url.replace(/#.*/, "");
    this.allTabs().forEach(function (t) {
      var turl = t.url().replace(/#.*/, "");
      if (turl == url) {
        if (t.state() == "normal") {
          t.makeLive();
        }
      }
    }, this);;
  },

  visitPage: function (url) {
    var tab = this.tabWithUrl(url);
    if (tab) {
      tab.activate();
      return;
    }
    this.open({
      url: url,
      inBackground: false
    });
  },

  get foreground() isForeground(this.sdkWindow)

});

exports.Tab = Class({

  initialize: function (tabSet, sdkTab) {
    bind(this, "createWorker _checkTitle");

    let alltabs = getTabs(tabSet.domWindow);
    for (let t in alltabs){
      if (getTabId(alltabs[t]) === sdkTab.id) {
        this.xulTab = alltabs[t];
      }
    }
    assert(this.xulTab); // must exist, should be a <tab.tabbrowser-tabs>
    this.sdkTab = sdkTab;
    this.tabSet = tabSet;
    this.id = this.tabSet.group.clientId + "_" + this.sdkTab.id;
    this.createWorker();
    this.sdkTab.on("pageshow", this.createWorker);
    this.sdkTab.on("pageshow", (function () {
      this.lastLoadTime = Date.now();
    }).bind(this));
    this.isMirroring = false;
    this.onReloadSendMirror = null;
    copyMethods(this, sdkTab, "pin unpin close reload activate getThumbnail");
  },

  destroy: function () {
    if (! this.sdkTab) {
      // Already destroyed
      return;
    }
    delete this.tabSet._tabsById[this.sdkTab.id];
    this.sdkTab.removeListener("pageshow", this.createWorker);
    this.sdkTab = null;
    this.tabSet = null;
    if (this.worker) {
      this.worker.destroy();
      this.worker = null;
    }
  },

  url: function () {
    return this.sdkTab.url;
  },

  isActive: function () {
    return this.sdkTab == tabs.activeTab;
  },

  hardActivate: function () {
    // Like .activate() but also brings the window into focus
    // FIXME: not sure if this works if Firefox is not in the
    // foreground.  But this *does* work on Nightly.
    this.tabSet.sdkWindow.activate();
    this.activate();
  },

  getJson: function (shortForm) {
    if (this.sdkTab) {
      this._lastTitle = this.sdkTab.title;
    }
    if (shortForm) {
      var deferred = defer();
      deferred.resolve({
        id: this.id,
        index: this.sdkTab ? this.sdkTab.index : 0,
        url: this.sdkTab ? this.sdkTab.url : "",
        closedAgo: this.closedAt ? Date.now() - this.closedAt : null
      });
      return deferred.promise;
    }
    var json = {
      id: this.id,
      index: this.sdkTab.index,
      pinned: this.sdkTab.pinned,
      title: this.sdkTab.title,
      url: this.sdkTab.url,
      state: this.state(),
      active: this.sdkTab == tabs.activeTab,
      lastEventAgo: Date.now() - this.lastEventAt,
      lastPageShowAgo: Date.now() - this.lastPageShowAt,
      lastActivateAgo: this.lastActivateAt ? Date.now() - this.lastActivateAt : null
    };
    return getFavicon(this.sdkTab).then(function (favicon) {
      json.favicon = favicon;
      return json;
    }, function (error) {
      return json;
    });
  },

  state: function () {
    if (this.sdkTab.url.indexOf(data.url("mirror/blank.html")) === 0) {
      return "viewing";
    }
    if (this.isPresenting) {
      return "presenting";
    }
    if (this.isLive) {
      return "live";
    }
    return "normal";
  },

  makeLive: function () {
    assert(this.state() == "normal" || this.state() == "live",
           "makeLive with bad state:", this.state());
    // FIXME: for some reason this particular message is getting lots of
    // failures
    try {
      this.worker.port.emit("setState", "live");
    } catch (e) {
      console.warn("Failed to setState live with worker, url:", this.sdkTab.url);
    }
    this.isLive = true;
    this.tabSet.emit("stateChange", this);
  },

  disableLive: function () {
    assert(this.state() == "live");
    this.worker.port.emit("setState", "normal");
    this.isLive = false;
    this.tabSet.emit("stateChange", this);
  },

  makePresenting: function () {
    if (this.state() == "live") {
      this.disableLive();
    }
    assert(this.state() == "normal" || this.state() == "presenting");
    this.worker.port.emit("setState", "presenting");
    this.isPresenting = true;
    this.tabSet.emit("stateChange", this);
  },

  disablePresenting: function () {
    assert(this.state() == "presenting");
    this.worker.port.emit("setState", "normal");
    this.isPresenting = false;
    this.checkForLive();
    this.tabSet.emit("stateChange", this);
    this.tabSet.emit("presentingOff", this);
  },

  replaceAsViewer: function (tabId) {
    var url = data.url("mirror/blank.html");
    url += "?tabId=" + encodeURIComponent(tabId);
    this.sdkTab.url = url;
  },

  disableViewing: function () {
    this.worker.port.emit("presentingOff");
  },

  checkForLive: function () {
    if (this.state() != "normal") {
      return;
    }
    if (this.url().search(/^about:/) === 0) {
      return;
    }
    var peers = this.tabSet.group.hub.peers.getAll();
    var thisUrl = this.url().replace(/#.*/, "");
    peers.forEach(function (p) {
      for (var tabId in p.tabs) {
        var url = p.tabs[tabId].replace(/#.*/, "");
        if (url == thisUrl) {
          this.makeLive();
          return;
        }
      }
    }, this);
  },

  mirrorTabId: function () {
    /* Returns the tab this is mirroring, if it is mirroring a tab;
       returns null otherwise */
    if (this.sdkTab.url.indexOf(data.url("mirror/blank.html")) !== 0) {
      return null;
    }
    var match = /tabId=([^&]*)/.exec(this.sdkTab.url);
    if (! match) {
      console.warn("Mirror tab without tabId:", this.sdkTab.url);
      return null;
    }
    return decodeURIComponent(match[1]);
  },

  createWorker: function () {
    if (this.worker) {
      this.worker.dying = true;
      this.worker.destroy();
      this.worker = null;
    }
    if (! this.sdkTab.attach) {
      console.log("creating worker on?", this.sdkTab, this.sdkTab.attach);
    }
    this.worker = this.sdkTab.attach({
      contentScriptFile: [
        data.url("mirror/freeze.js"),
        data.url("sidebar/js/util.js"),
        data.url("pageworker/worker.js")
      ]
    });
    this.worker.creationUrl = this.sdkTab.url;
    setHandlers(this.worker.port, this.workerOn, this, [this.worker]);
    if (this.state() == "viewing") {
      this.tabSet.emit("stateChange", this);
    }
  },

  _checkTitle: function () {
    setTimeout((function () {
      if (this._lastTitle && this.sdkTab.title != this._lastTitle) {
        this.tabSet.emit("titleupdate", this);
        this._lastTitle = this.sdkTab.title;
      }
    }).bind(this), 200);
  },

  workerOn: {
    ready: function (worker) {
      if (worker != this.worker) {
        console.warn("Got ready message from stale worker");
        return;
      }
      if ((! this.sdkTab) || ! worker.tab) {
        // We're tearing down right now
        return;
      }
      var state = this.state();
      if (state == "live") {
        this.isLive = false;
        state = "normal";
      }
      try {
        worker.port.emit("init", {
          clientId: this.tabSet.group.clientId,
          selfIdentity: this.tabSet.group.selfIdentity,
          groupId: this.tabSet.group.groupId,
          togetherJsLocation: require("sdk/simple-prefs").prefs.togetherJsLocation,
          tabId: this.id,
          viewerScript: viewerScript,
          togetherJsCss: togetherJsCss,
          state: state
        });
      } catch (e) {
        if (this.worker.creationUrl != "about:blank") {
          console.log("Is dying?", this.worker.dying, this.worker.creationUrl);
          console.log("init failed:", e.name, e+"");
        }
      }
      if (this.state() == "viewing" && ! this.onReloadSendMirror) {
        this.tabSet.group.hub.send({
          type: "mirror-fault",
          tabId: this.mirrorTabId()
        });
      }
      if (this.state() == "normal") {
        this.checkForLive();
      }
      if (this.onReloadSendMirror) {
        this.onReloadSendMirror.forEach(function (args) {
          if (args[0] == "mirror-doc") {
            this._checkTitle();
          }
          this.worker.port.emit.apply(this.worker.port, args);
        }, this);
        this.onReloadSendMirror = null;
      }
    },

    emitMirror: function (worker, msg) {
      msg.tabId = this.id;
      msg.type = "mirror-doc";
      msg.url = this.sdkTab.url.replace(/#.*/, "");
      this.tabSet.group.hub.send(msg);
    },

    mirrorReload: function (worker, msg) {
      this.onReloadSendMirror = [["mirror-doc", msg]];
      this.reload();
    },

    mirrorFault: function (worker) {
      this.tabSet.group.hub.send({
        type: "mirror-fault",
        tabId: this.mirrorTabId()
      });
    }
  }

});
