window.__ModuleLoader__.load({
  id: "dsh-comment-viewer",
  factory: (require) => {
    const { createElement: h } = require("react");
    const panelId = "comment-viewer";
    const appPath = "/plugins/dsh-comment-viewer/app";

    /** 侧边栏 / 主区域的页面：直接内嵌静态评论分析台（iframe 隔离样式，不污染 DSH） */
    function ViewerFrame() {
      return h("iframe", {
        src: `${appPath}/?embed=1`,
        title: "评论词云",
        style: {
          display: "block",
          width: "100%",
          height: "100%",
          border: "0",
          background: "#0b0b0c",
          colorScheme: "dark",
        },
      });
    }

    function ViewerIcon() {
      return h(
        "svg",
        {
          width: 20,
          height: 20,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        h("circle", { cx: 8, cy: 9, r: 3.4 }),
        h("circle", { cx: 15.5, cy: 7.5, r: 2.4 }),
        h("circle", { cx: 12.5, cy: 14.5, r: 4.2 }),
        h("circle", { cx: 18, cy: 15, r: 1.8 }),
      );
    }

    return {
      inject: ["slots", "sidebarRightTabs"],
      apply(ctx) {
        ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: panelId }, ViewerFrame));
        ctx.effect(() =>
          ctx.sidebarRightTabs.register({
            id: panelId,
            kind: panelId,
            title: () => "评论词云",
            keepMounted: true,
            guide: [
              {
                id: "comment-viewer",
                order: 41,
                title: () => "评论词云",
                description: () => "交互词云 + 评论表：悬停看评论、点昵称跳主页",
                icon: ViewerIcon,
              },
            ],
          }),
        );
        ctx.slots.inject("sidebar.right.pane.tab", () =>
          ctx.slots.register({ name: "sidebar.right.pane.tab", key: panelId }, ViewerFrame),
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register({ name: "sidebar.panellist", id: panelId, order: 22, label: () => "评论词云" }, ViewerIcon),
        );
      },
    };
  },
});
