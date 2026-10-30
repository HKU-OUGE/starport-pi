import React from "react";
export default class PreviewBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        预览组件无法加载。
        <button type="button" onClick={() => location.reload()}>
          刷新页面
        </button>
      </p>
    ) : (
      this.props.children
    );
  }
}
