import { AuthData, Docker, TaggedImages } from './docker';
import { GitRefType, parseBool, parseGitRef } from './utils';
import * as core from '@actions/core';
import path from 'path';
import { context } from '@actions/github';

type ImageHashes = { [name: string]: string }

class ContainerBuilder {
  private readonly docker: Docker;
  private readonly targetRepository: string;
  private readonly targetAuth: AuthData;
  private readonly cacheRepository: string;
  private readonly cacheAuth: AuthData;

  private readonly enableBuild: boolean;
  private readonly buildContext: string;
  private readonly buildDockerfile: string;

  private readonly enablePublish: boolean;
  private readonly staticTags: string[];
  private readonly tagWithRef: boolean;
  private readonly tagWithSHA: boolean;

  constructor() {
    this.docker = new Docker();

    this.targetRepository = core.getInput('target_repository', { required: true });
    this.targetAuth = {
      username: core.getInput('target_registry_username', { required: true }),
      password: core.getInput('target_registry_password', { required: true }),
    };

    this.cacheRepository = core.getInput('cache_repository') || `${this.targetRepository}-cache`;
    this.cacheAuth = {
      username: core.getInput('cache_registry_username') || this.targetAuth.username,
      password: core.getInput('cache_registry_password') || this.targetAuth.password,
    };

    this.enableBuild = parseBool(core.getInput('build') || 'true');
    this.buildContext = core.getInput('build_context') || '.';
    this.buildDockerfile = path.join(this.buildContext, core.getInput('build_dockerfile') || 'Dockerfile');

    this.enablePublish = parseBool(core.getInput('publish') || 'true');
    this.staticTags = core.getInput('tags').split(',').filter(Boolean);
    this.tagWithRef = parseBool(core.getInput('tag_with_ref') || 'false');
    this.tagWithSHA = parseBool(core.getInput('tag_with_sha') || 'false');
  }

  async run() {
    let finalImage: string | null = null;

    if (this.enableBuild) {
      const stageCache = await this.pullCachedStages();
      const newImages = await this.assembleImage(stageCache);
      await this.pushCachedStages(newImages);
      await this.cleanCachedStages(stageCache, newImages);

      const finalImageName = `${this.cacheRepository}:final`;
      if (newImages[finalImageName]) {
        finalImage = newImages[finalImageName];
        core.setOutput('build_output', finalImageName);
      } else {
        throw new Error(`Could not final image output from build: ${finalImageName}`);
      }
    } else {
      core.info(`Skipping build phase due to being disabled in configuration`);
    }

    if (this.enablePublish) {
      if (finalImage) core.info(`Using previously built image for publishing...`);
      else finalImage = await this.searchPreviousBuild();

      const taggedImages = await this.buildTargetImage(finalImage);
      await this.publishImages(taggedImages);
    } else {
      core.info(`Skipping publish phase due to being disabled in configuration`);
    }
  }

  private async pullCachedStages(): Promise<TaggedImages> {
    try {
      core.info(`Attempting to pull all cached stages from repository [${this.cacheRepository}]...`);
      await this.docker.pullImage(this.cacheRepository, { auth: this.cacheAuth });

      core.info(`Analyzing retrieved cache images of [${this.cacheRepository}]...`);
      const stageCache = await this.docker.getImageTags(this.cacheRepository);
      const tags = Object.keys(stageCache);
      core.info(`Found ${tags.length} previous cache images: ${tags.join(', ')}`);

      return stageCache;
    } catch (e) {
      core.info(`Could not retrieve cached stages, continuing without cache: ${e}`);
      return {};
    }
  }

  private async assembleImage(stageCache: TaggedImages): Promise<ImageHashes> {
    // Generate tarball of build context
    const archive = await this.docker.packBuildContext(this.buildContext);

    // Prepare for building the Dockerfile
    const newImages: ImageHashes = {};
    const cacheFrom = Object.values(stageCache);

    // Determine multi-stage targets and build each one separately
    const targets = await this.docker.parseBuildTargets(this.buildDockerfile);
    for (const target of targets) {
      // Build image for the given target
      core.info(`Building multi-stage target [${target}] with caches [${cacheFrom.join(', ')}]...`);
      const imageName = `${this.cacheRepository}:stage-${target}`;
      const imageID = await this.docker.buildImage(archive, imageName, { cacheFrom, target });

      // Keep reference to built target image and add it to the cache
      newImages[imageName] = imageID;
      cacheFrom.unshift(imageID);
      core.info(`Built multi-stage target [${target}] as [${imageID}]`);
    }

    // Build the final stage of the Dockerfile
    const imageName = `${this.cacheRepository}:final`;
    core.info(`Building final stage [${imageName}] with caches [${cacheFrom.join(', ')}]...`);
    const imageID = await this.docker.buildImage(archive, imageName, { cacheFrom });

    // Keep reference to built image
    newImages[imageName] = imageID;
    core.info(`Built final stage [${imageName}] as [${imageID}]`);

    return newImages;
  }

  private async pushCachedStages(newImages: ImageHashes): Promise<void> {
    for (const [imageName, imageID] of Object.entries(newImages)) {
      core.info(`Pushing cached stage [${imageName}] (${imageID})...`);
      await this.docker.pushImage(imageName, { auth: this.cacheAuth });
    }
  }

  private async cleanCachedStages(stageCache: TaggedImages, newImages: ImageHashes): Promise<void> {
    const currentTags = Object.keys(stageCache);
    const expectedTags = Object.keys(newImages).map(x => this.docker.parseImageName(x).tag).filter(Boolean);

    for (const tag of currentTags) {
      if (expectedTags.indexOf(tag) === -1) {
        core.info(`Found outdated cache image: ${this.cacheRepository}:${tag}`);
        await this.docker.unpublishImage(`${this.cacheRepository}:${tag}`, { auth: this.cacheAuth });
      }
    }
  }

  private async searchPreviousBuild(): Promise<string> {
    core.info(`Attempting to search for previous local build in repository [${this.cacheRepository}]...`);
    const taggedImages = await this.docker.getImageTags(this.cacheRepository);

    const finalImage = taggedImages['final'];
    const finalImageName = `${this.cacheRepository}:final`;
    if (!finalImage) throw new Error(`could not find previous local build [${finalImageName}]`);

    core.info(`Using previous build [${finalImageName}] for publishing`);
    return finalImage;
  }

  private async buildTargetImage(finalImage: string): Promise<string[]> {
    // Prepare list of desired image tags
    const desiredTags = [...this.staticTags];

    // Add tag with Git commit hash
    if (this.tagWithSHA && context.sha) {
      if (context.sha.length >= 7) {
        const shortSHA = context.sha.substring(0, 7);
        desiredTags.push(`sha-${shortSHA}`);
      }
    }

    // Add tag with Git reference
    if (this.tagWithRef && context.ref) {
      const ref = parseGitRef(context.ref);
      switch (ref.type) {
        case GitRefType.Head:
          if (ref.name === 'master') desiredTags.push('latest');
          else if (ref.name) desiredTags.push(ref.name);
          break;
        case GitRefType.PullRequest:
          if (ref.name) desiredTags.push(`pr-${ref.name}`);
          break;
        case GitRefType.Tag:
          if (ref.name) desiredTags.push(ref.name);
          break;
      }
    }

    // Tag final image with all desired tags
    const taggedImages = [];
    for (const tag of desiredTags) {
      core.info(`Tagging final image as [${this.targetRepository}:${tag}]...`);
      taggedImages.push(`${this.targetRepository}:${tag}`);
      await this.docker.tagImage(finalImage, this.targetRepository, tag);
    }

    return taggedImages;
  }

  private async publishImages(images: string[]): Promise<void> {
    for (const image of images) {
      core.info(`Pushing image [${image}] to registry...`);
      await this.docker.pushImage(image, { auth: this.targetAuth });
    }
  }
}

new ContainerBuilder().run().catch(err => {
  core.setFailed(err);
});
