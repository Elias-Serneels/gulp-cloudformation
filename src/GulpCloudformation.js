//-------------------------------------------------------------------------------
// Imports
//-------------------------------------------------------------------------------

import { obj } from 'through2'
import log from 'fancy-log'
import File from 'vinyl'
import { Observable } from 'rx-lite'
import { basename, extname } from 'path'


//-------------------------------------------------------------------------------
// Simplify References
//-------------------------------------------------------------------------------

const { range, timer, just, fromNodeCallback } = Observable
const { pow } = Math
const { stringify } = JSON


//-------------------------------------------------------------------------------
// Declare Class
//-------------------------------------------------------------------------------

export default class GulpCloudformation {

  //-------------------------------------------------------------------------------
  // Constructor
  //-------------------------------------------------------------------------------

  constructor(context) {

    //-------------------------------------------------------------------------------
    // Public Properties
    //-------------------------------------------------------------------------------

    /**
     * @private
     * @type {CloudFormation}
     */
    this.context = context

    this.describeStacks = fromNodeCallback(this.context.describeStacks, this.context)

    this.createStack = fromNodeCallback(this.context.createStack, this.context)

    this.updateStack = fromNodeCallback(this.context.updateStack, this.context)

    this.validateTemplate = fromNodeCallback(this.context.validateTemplate, this.context)
  }


  //-------------------------------------------------------------------------------
  // Public Methods
  //-------------------------------------------------------------------------------

  validate() {
    const main = ({TemplateBody}) => {
      return this.validateTemplate({
        TemplateBody
      })
      .map(log)
      .catch(err => {
        log(err)
        throw err
      })
    }

    function transform(file, enc, done) {
      if (file.isNull() || file.isStream()) {
        this.push(file)
        return done()
      }

      const {contents} = file
      const TemplateBody = contents.toString(enc)

      return main({TemplateBody})
        .subscribe(() => {
          this.push(file)
          return done()
        })
    }

    return obj(transform)
  }

  deploy(params = {}) {
    const _this = this
    function transform(file, enc, done) {
      if (file.isNull() || file.isStream()) {
        this.push(file)
        return done()
      }

      const {path, contents} = file
      const ext = extname(path)
      const StackName = params.StackName || basename(path, ext)
      const TemplateBody = contents.toString(enc)

      let acc

      return _this.doDeploy(StackName, TemplateBody, params)
      .subscribe(
        value => acc = value, done,
        () => {
          const buffer = new Buffer(stringify(acc), enc)
          const newFile = new File({...file, contents: buffer})
          this.push(newFile)
          return done()
        }
      )
    }

    return obj(transform)
  }


  //-------------------------------------------------------------------------------
  // Private Methods
  //-------------------------------------------------------------------------------

  /**
  * @private
  * @param {string} StackName
  * @param {string} TemplateBody
  * @param params
  * @returns {Observable}
  */
  doDeploy(StackName, TemplateBody, params) {
    return this.upsertStack({
      StackName,
      TemplateBody,
      ...params
    })
    .map(log)
    .map(() => ({StackName}))
    .catch(err => {
      log(err)
      return just({StackName})
    })
    .flatMap(fetchParams => this.fetchOutputs(fetchParams))
    .flatMap(({Outputs}) => Outputs)
    .map(({OutputKey, OutputValue}) => {
      return {[OutputKey]: OutputValue}
    })
    .scan((acc, value) => Object.assign(acc, value), {})
  }

  hasStack(params) {
    return this.describeStacks(params)
    .flatMap(({Stacks}) => Stacks)
    .filter(this.isComplete)
    .catch(() => just(false))
  }

  upsertStack(params) {
    const {StackName} = params
    return this.hasStack({StackName})
    .flatMap(hasStack => {
      if (hasStack) {
        return this.updateStack(params)
      }

      return this.createStack({
        ...params,
        OnFailure: 'DELETE'
      })
    })
  }

  fetchOutputs(params) {
    return range(0, 20)
      .delay(x => timer(1000 * pow(2, x)))
      .flatMap(() => this.describeStacks(params))
      .flatMap(({Stacks}) => Stacks)
      .filter(this.isComplete)
      .take(1)
  }

  /**
  * @private
  * @param {{StackStatus: string}}
  * @returns {boolean}
  */
  isComplete({StackStatus}) {
    log('StackStatus', StackStatus)

    switch (StackStatus) {
      case 'CREATE_COMPLETE':
      case 'DELETE_COMPLETE':
      case 'ROLLBACK_COMPLETE':
      case 'UPDATE_COMPLETE':
      case 'UPDATE_ROLLBACK_COMPLETE':
        return true

      case 'CREATE_FAILED':
      case 'DELETE_FAILED':
      case 'ROLLBACK_FAILED':
      case 'UPDATE_ROLLBACK_FAILED':
        throw new Error()

      case 'CREATE_IN_PROGRESS':
      case 'DELETE_IN_PROGRESS':
      case 'ROLLBACK_IN_PROGRESS':
      case 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS':
      case 'UPDATE_IN_PROGRESS':
      case 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS':
      case 'UPDATE_ROLLBACK_IN_PROGRESS':
      default:
        return false
    }
  }
}
