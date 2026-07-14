import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// Order tells the story: tour → machines → the glue → the machinery →
// what it all runs → how we watch it → what it's for → what holds it up.
const sidebars: SidebarsConfig = {
  docs: [
    'index',
    {type: 'category', label: 'The Hardware', collapsed: false, items: [
      'hardware/nodes', 'hardware/the-rest-of-the-fleet',
    ]},
    {type: 'category', label: 'Foundations', items: [
      'foundations/k3s', 'foundations/networking', 'foundations/storage',
    ]},
    {type: 'category', label: 'The Connective Tissue', items: [
      'tissue/trust-fabric', 'tissue/red-tape', 'tissue/delegation-ladder',
    ]},
    {type: 'category', label: 'GitOps & the Machinery', items: [
      'gitops/argocd', 'gitops/renovate', 'gitops/the-trio', 'gitops/ci-loops', 'gitops/kustomize-evolution',
    ]},
    {type: 'category', label: 'Inference & AI', items: [
      'ai/inference-fleet', 'ai/litellm', 'ai/rampart', 'ai/hermes', 'ai/code-server',
    ]},
    {type: 'category', label: 'Data / Orchestration', items: [
      'data/dagster',
      'data/dagster-projects',
      'data/n8n',
    ]},
    {type: 'category', label: 'Observability & Alerting', items: [
      'observability/prometheus-grafana', 'observability/logs', 'observability/alerting', 'observability/scrutiny',
    ]},
    {type: 'category', label: 'Media & Life', items: [
      'media/jellyfin', 'media/immich', 'media/paperless', 'media/music-and-books', 'media/downloads',
    ]},
    {type: 'category', label: 'Platform Services', items: [
      'platform/vaultwarden', 'platform/backups', 'platform/harbor', 'platform/forgejo', 'platform/mailpit',
    ]},
  ],
};

export default sidebars;
